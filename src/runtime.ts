// The C runtime library: F_putchar, F_getchar, F_printf, F_scanf, F_strcmp,
// F_strcpy, plus the F_malloc/F_free heap runtime. The implementation is
// original LC-3 assembly for the documented standard-library subset,
// including formatted I/O, strings, and heap allocation,
// hand-written to the same callee convention codegen.ts emits
// so a student stepping into printf sees the same frame discipline as any
// compiled function: four-action prologue, a return-value slot at R5+3,
// R4-R7 preserved, R0-R3 free. Code generation emits
// `JSR F_putchar` / `JSR F_getchar` / `JSR F_printf`; the
// same calling shape covers `JSR F_scanf` / `JSR F_strcmp` /
// `JSR F_strcpy`, and reaches `JSR F_malloc` / `JSR F_free` the same
// way (check.ts seeds all eight as builtins); this file supplies the bodies
// those JSRs land in. Runtime assembly is organized in RUNTIME_SECTIONS,
// keyed by C function name rather than stored as one monolithic blob.
// Codegen scans the emitted program for which of
// these names it actually calls, splices the transitive closure of
// RUNTIME_ORDER-ordered sections (a section's own `needs` list pulls in
// whatever it depends on) into the program's single .ORIG block (no
// .ORIG/.END of its own) immediately after the last user function, and
// omits every section a program never calls — see emitRuntimeIfNeeded in
// codegen.ts. putchar, printf, strcmp, and strcpy need nothing else
// (printf reaches the console through TRAP x21 directly, never JSR
// F_putchar/F_getchar), so they stay leaves. scanf -> getchar is one runtime I/O
// dependency edge for the shared pushback
// slot both route through — see F_scanf's design note below. The heap runtime
// adds a free -> malloc edge because free shares malloc's unsigned helper
// and heap-head storage. Two sections are operators rather than C functions —
// op-mul (RTMUL) and op-divmod (RTDIV/RTMOD) — the runtime homes of *, /,
// and %; see the label-hygiene note below and each section's own comment.
//
// TRAP safety inside a callee follows the machine's exception contract:
// the operating-system routines reached by TRAP preserve documented registers.
// TRAP pushes PSR/PC on the SUPERVISOR stack and returns via RTI, so it
// does not touch R7 (the caller's/our own return address lives safely in
// the frame, not in a register TRAP could clobber) and does not touch the
// condition codes as observed by the user program (RTI restores the exact
// PSR — including CC — that was live the instant TRAP executed). TRAP DOES
// bank R6 to the supervisor stack pointer for the routine's own duration,
// but restores the user R6 before RTI, so it is always safe to call from
// inside a function body — the frame's own R6 arithmetic never observes
// the banking. The operating-system GETC and OUT routines establish the details:
// OUT touches only R1 (saved/restored) — R0, R2, R3 survive
// a TRAP x21 completely unmodified; TRAP x20 overwrites R0 (that is its
// purpose) but likewise leaves R1-R3 untouched. F_printf's conversion
// loops below rely on this: they hold live state in R0-R3 across TRAP x21
// calls without ever spilling to memory for that reason alone.
//
// Label hygiene: every internal label uses one of eight RT-prefixes, keyed
// to its section — RTPF_ (printf), RTIO_ (the getchar/scanf pushback
// slot), RTSC_ (scanf), RTCMP_ (strcmp), RTCPY_ (strcpy), RTMUL_ (op-mul),
// RTDVM_ (op-divmod's shared core), RTHP_ (malloc/free) — each disjoint
// from every label shape codegen.ts generates for user code (F_<name>,
// L_<name>_N, C_<name>_N, S_N, GLOBAL, CRT0_GLOBAL, CRT0_STACK) for any
// name a user's C identifier could produce. The eight C-callable entry
// points share codegen's
// F_<name> shape by necessity (that's the whole point —
// they must be exactly what a `JSR F_printf` compiled from `printf(...)`
// expects). seedBuiltins (check.ts) seeds all eight with isBuiltin: true, and
// registerFunction rejects a user program that tries to redefine one — see
// its isBuiltin guard and tests. Codegen conditionally reserves only runtime
// bases that will be live, while its actual-emitted-user-label scan filter
// remains the final runtime-splice authority.
// The two operator sections use the opposite naming choice on purpose:
// labels are RTMUL, RTDIV, and RTMOD — RT-shaped, NOT F_-shaped — because
// a user's own `int mul()` legally emits F_mul, and reserving the name the
// way the eight C-callable runtime builtins are reserved would be hostile in
// exactly the teaching cases where users write their own mul/div. No C
// call ever reaches them. Codegen emits JSR RTMUL/RTDIV/RTMOD for
// *, /, and %, and records each required section explicitly through
// usedOpSections rather than inferring it from a C-call label scan.
// That separation also prevents collisions with user function names.
//
// F_printf's variadic contract uses a right-to-left push:
// puts the format string, always the leftmost argument, at the callee's
// R5+4 regardless of arity — Fig 18.3 — with each subsequent vararg at
// R5+5, R5+6, ...):
//
// Frame layout (all of F_printf's own locals, R5-relative):
//   R5+0        fmtPtr     -- current position in the format string
//   R5-1        argPtr     -- address of the next vararg to consume
//   R5-2..R5-6  digit buffer (5 words) -- %d only, see below
//   R5-7        charCount  -- running total, written to R5+3 at the end
//                             (printf returns the character count, C's
//                             usual contract, unlike a user function's
//                             possibly-missing return, the runtime fully
//                             controls every path here)
// Both fmtPtr and argPtr live in memory (not registers) for the whole
// function: this lets every conversion handler below use ALL of R0-R3 as
// pure scratch without tracking which registers some other part of the
// function is depending on to survive a branch — reload from the local,
// do the work, store back if it changed. Slower than a register-resident
// design, clearer to get right by hand.
//
// Conversions implemented (kept in step with the checker's
// PRINTF_OK_CONVERSIONS): %d (signed decimal, including INT_MIN),
// %c, %x, %b, %s, %%. An unrecognized specifier can only reach this code if
// the checker's own rejection was bypassed somehow (defensive, not
// load-bearing): printed literally as '%' followed by the specifier
// character, a defensive fallback for unreachable input.
//
// %d: no DIV instruction on the LC-3, so both the divide-by-10 digit
// extraction and INT_MIN require dedicated LC-3 code (the
// "division/modulus codegen never shown" applies equally to a hand-written
// runtime): each digit is peeled off via repeated subtraction of 10
// (mirroring the compiler's own div/mod lowering in codegen.ts),
// least-significant
// digit first, into a 5-word buffer (5 decimal digits covers the largest
// magnitude this scheme ever computes, 32767 — INT_MIN is diverted before
// reaching this code, see below), then printed back out most-significant
// first. -32768 is the one value whose magnitude has no positive 16-bit
// representation (NOT/ADD#1 on -32768 yields -32768 again, unchanged) —
// detected up front by adding the argument to the constant -32768 with
// ordinary 16-bit wraparound: for any OTHER value that sum is nonzero, and
// for exactly -32768 it wraps to 0 (0x8000 + 0x8000 = 0x10000 -> 0 mod
// 2^16). When detected, the routine prints the literal string "-32768"
// and skips the normal path entirely, sidestepping the negation trick
// altogether rather than trying to patch it.
//
// %x: unpadded lowercase hexadecimal (Appendix D Table D.6 / D.9.1.4).
// Leading zero nibbles are suppressed, so "%x" of 0 is a single "0" (never
// "0000" or empty) and the returned count reflects only the digits
// actually emitted — the same leading-zero discipline RTPF_CONV_D applies
// to decimal. %X (uppercase) is deliberately NOT implemented; it stays an
// unrecognized specifier. Each nibble is extracted MSB-first by the same
// doubling-and-test-sign trick codegen.ts's own `>>` operator lowering
// uses in emitShiftRightCombine: double the working
// value and test its sign to read off progressively lower bits of the
// ORIGINAL value, four bits at a time, four times.
//
// %b: prints all 16 bits, always, so "%b" of 5 is "0000000000000101", not
// "101" — a deliberate extension beyond ISO C's own conversion set.
// Same bit-extraction trick as %x, one bit at a time, no
// nibble grouping needed.
//
// %s: the vararg is the ADDRESS of a char array/pointer (checker-enforced —
// check.ts's checkPrintfCall requires char* after decay), not a value to
// format the way every other conversion's vararg is. RTPF_CONV_S reads that
// one address out of argPtr (the usual single bump, exactly like %c), then
// walks memory from there printing words one at a time until it hits a zero
// word, the same terminator convention .STRINGZ storage and RTPF_LOOP's own
// format-string walk already use. Each character emitted counts toward
// charCount through the same RTPF_BUMP every other conversion uses, so an
// empty string (terminator immediately) adds nothing to printf's return
// value and a non-empty one adds exactly its length. The walking pointer
// lives in R1 for the duration of the loop, surviving TRAP x21 and JSR
// RTPF_BUMP across iterations the same way RTPF_CONV_D/X/B keep R1-R3 live
// across those calls (see the TRAP-safety note above and RTPF_BUMP's own
// clobber comment) — no register convention invented for this handler that
// the others do not already rely on.
//
// Branch headroom: every branch inside this section is a
// plain LC-3 BR/BRcc, whose PCoffset9 is a signed 9-bit word count (-256..255
// from the instruction after it) — there is no long-branch fallback.
// The whole assembled printf section is 225 words and its
// worst-case branch is the `BR RTPF_LOOP` inside RTPF_CONV_PCT, at -177
// (RTPF_LOOP sits at offset 13 from F_printf's start, that BR at offset 189,
// 13 - 190 = -177 — verified against the assembled word itself, not just
// address arithmetic: decoding the low 9 bits of the machine word at that
// address gives the identical -177), comfortably inside range
// with 79 words of negative headroom. Another four or five
// conversion handlers of similar size would consume that margin and push
// some `BR RTPF_LOOP` out of the
// -256..255 window entirely. The failure mode when that happens is NOT a
// test failing in this file — it is the real assembler rejecting the spliced
// program with a PCoffset9-out-of-range diagnostic at whatever program
// first happens to call printf, since codegen.ts splices this section
// verbatim with no reach check of its own. Whoever adds the next conversion
// should re-measure (assemble RUNTIME_SECTIONS.get('printf').asm alone and
// check the resulting word count/worst branch offset) rather than assume
// there is still room.
//
// F_scanf supports %s, literal-character matching, and format whitespace
// under the same callee convention as everything else, so stepping into
// it shows the same frame discipline as other runtime entries.
//
// Frame layout (R5-relative):
//   R5+0   fmtPtr      -- current position in the format string
//   R5-1   argPtr      -- address of the next vararg, which is itself a
//                         POINTER for every conversion this file implements
//                         (e.g. &n, &c, or a char array's own decayed
//                         address for %s) -- unlike printf, whose %d/%c
//                         varargs are values, scanf's varargs are always the
//                         address to write through
//   R5-2   assignCount -- running total of successful assignments, written
//                         to R5+3 at the end (scanf's book-defined return
//                         value, D.9.1.3)
//   R5-3   digitSeen   -- %d-only scratch: 0 until the first
//                         digit is accumulated, so a %d that consumes zero
//                         digits can be told apart from one that genuinely
//                         reads the value 0 -- both leave the accumulator
//                         at exactly 0, so the accumulator alone cannot
//                         make that distinction (see RTSC_CONV_D below)
// %d's sign flag while its digits accumulate (RTSC_CONV_D) and %s's
// destination write pointer (RTSC_CONV_S) both live in R3, a REGISTER, not
// a memory local -- neither needs to survive anything but the ADD-based
// JSRs (RTIO_GETCH/RTIO_UNGETCH) inside that one conversion's own loop.
// RTIO_GETCH and RTIO_UNGETCH do NOT share one clobber set, and code in
// this file must not treat them as if they did: RTIO_GETCH clobbers R0 and
// R1; RTIO_UNGETCH clobbers neither, only R7 (see each one's own clobber
// note below). Assuming the wider, GETCH-shaped set applies to a
// RTIO_UNGETCH call too is exactly the mistake that would let %s's own
// NUL-terminator write silently read stale data -- which is why that write
// (RTSC_S_DONE) is ordered before its own RTIO_UNGETCH call, not after: it
// depends on R1 surviving, and should depend on that fact being written
// down accurately, not on an over-wide clobber note nobody double-checked.
// Because neither call touches R2/R3/R5/R6 regardless, spilling either the
// sign flag or the write pointer to memory would just be an unused frame
// word either way. The prologue below reserves exactly the four memory
// locals above (`ADD R6,R6,#-4`).
//
// Conversions implemented: %d, %c, %s (check.ts's SCANF_OK_CONVERSIONS),
// %% (matching one literal percent and assigning nothing), plus
// literal-character matching and whitespace-in-format handling.
// check.ts's checkScanfFormat rejects anything else at compile time, so
// F_scanf's dispatch loop below never has to cope with a shape it doesn't
// implement.
//
// %c does NOT skip leading whitespace -- it reads exactly the next
// character, whitespace or not. %d and %s both DO skip it, each with its
// own leading-whitespace loop (RTSC_D_SKIPWS, RTSC_S_SKIPWS) that runs
// regardless of whether the format itself has a whitespace character just
// before the conversion -- a conversion's own implicit skip and the
// format's explicit whitespace matching (RTSC_SKIPWS, below) are two
// unrelated mechanisms that happen to both consume input whitespace. The
// pushback slot is why any of this can look one character ahead before
// committing: %d needs it to know where a number ends, %s needs it to know
// where a token ends, and RTSC_LITERAL/RTSC_SKIPWS need it to test an input
// character before deciding whether to consume it -- whatever that
// lookahead character turns out to be must still be visible to whoever
// reads next, be it another scanf conversion or a getchar call.
//
// %d: skips leading whitespace (space/tab/newline), accepts an optional
// leading '+' or '-', then accumulates decimal digits. No DIV or MUL
// instruction on the LC-3, so `value*10 + digit` is built from ADD alone:
// double the running value three times (2x, 4x, 8x), add the once-doubled
// value back in (8x+2x=10x), then add the new digit -- mirroring this
// compiler's own ADD-only no-MUL/no-DIV idiom the same way
// RTPF_CONV_D's digit extraction mirrors it for printf. The loop stops at
// the first non-digit, which is pushed back (RTIO_UNGETCH) rather than
// consumed, since it belongs to whatever reads next -- a following
// conversion in the same scanf call, or a later getchar() call, either
// way through the same pushback slot. If zero digits are ever consumed
// (whether or not a sign character was), the conversion has failed to
// match: nothing is stored, assignCount does not advance, and the entire
// scan aborts the same way RTSC_LITERAL's own mismatch does;
// RTSC_D_DONE_DIGITS below).
//
// %s: reads a whitespace-delimited token into the destination char array
// (the vararg's own address, exactly like %c's destination -- check.ts's
// checkScanfCall requires `char *` after decay, mirroring printf's %s
// argument check) and NUL-terminates it at the first whitespace character.
// There is no field-width syntax in this subset (the format contract's
// scope), so a token longer than the destination array overruns it -- the
// same overrun behavior arrays have everywhere else in this compiler, and
// deliberately not guarded against here.
//
// Whitespace and literal characters in the format (RTSC_SKIPWS,
// RTSC_LITERAL): a whitespace character (space/tab/newline) in the format
// matches zero or more whitespace characters in the input -- read and
// discard input characters one at a time while they are whitespace, then
// push back the first one that is not (RTSC_SKIPWS). Any other format
// character is a literal that must match the next input character
// EXACTLY, with no skipping in front of it (RTSC_LITERAL): read one input
// character, and if it differs, push it back and abandon the rest of the
// format -- every conversion still to come is skipped, and scanf returns
// however many assignments already succeeded (D.9.1.3). A literal match
// that succeeds does not itself count toward that return value; only a
// conversion that actually stores through a vararg does.
//
// Literal matching follows standard scanf behavior: a literal non-whitespace
// format character must match the next input character exactly. It never
// skips input whitespace to search for a later match. RTSC_LITERAL implements
// that rule directly, while RTSC_SKIPWS handles whitespace that appears
// explicitly in the format. Keeping those paths separate prevents literal
// matching from consuming input that belongs to a later conversion.
// The state machine is therefore fully described by the two paths above.
//
// One accepted rough edge remains: a sign
// character not followed by a digit is a matching failure like any other
// zero-digit %d (see above) -- the scan aborts without storing or
// counting -- but the sign character itself was already consumed via
// RTIO_GETCH before the digit test ever ran, and only the NON-digit that
// follows it is pushed back. The sign is unrecoverable; a second pushback
// slot to preserve it would only serve malformed input, which is not worth
// the extra state.
//
// The one-character pushback slot (RTIO_PUSHBACK / RTIO_GETCH /
// RTIO_UNGETCH, in the 'getchar' section below, not this one) is shared
// with getchar, not owned by scanf: getchar must see a character scanf
// looked ahead at and ungot, or a program mixing scanf and getchar would
// silently drop one. It lives in getchar's RUNTIME_SECTIONS entry because
// scanf's `needs: ['getchar']` guarantees getchar's section is always
// spliced alongside scanf's, so scanf's own references to
// RTIO_GETCH/RTIO_UNGETCH/RTIO_PUSHBACK can never dangle. The reverse
// placement would break a getchar-only program: getchar has no `needs` on
// scanf, so a program calling only getchar would never splice scanf's
// section, and F_getchar's JSR RTIO_GETCH would resolve to nothing at
// assemble time. One word, one owner, chosen by which direction the real
// dependency points.
//
// Branch headroom follows the same PCoffset9 constraint as printf's own
// headroom note above -- and PCoffset9 applies equally to LD/LDI/ST/STI/LEA,
// not just BR/BRcc, so both directions of reference need checking, not only
// backward branches. The assembled scanf section is 189 words. Its
// binding constraint is a forward reference, not a backward branch:
// RTSC_LOOP's first classification check loads RTSC_C_NEG_PCT
// from offset 18 at F_SCANF's start and reaches the constant pool
// at offset 182 -- a PCoffset9 of +163 (255 max), leaving 92 words
// of margin. The
// worst backward branch (the final `BR RTSC_LOOP` inside RTSC_S_DONE, %s's
// exit) is -158 (-256 min), 98 words of margin -- looser than the
// forward case, and easy to mistake for the binding one since printf's own
// note above only ever discusses backward branches. Both figures verified
// against the real assembler (assembling RUNTIME_SECTIONS.get('getchar').asm
// followed by RUNTIME_SECTIONS.get('scanf').asm, since scanf's own
// RTIO_GETCH/RTIO_UNGETCH references need getchar's labels to resolve, then
// decoding every LD/BR-class word's low 9 bits in the assembled scanf range
// and comparing each against its own address). Whoever adds the next scanf
// conversion should re-measure the same way, checking LD reach into the
// constant pool as well as BR reach to RTSC_LOOP, rather than assume either
// margin holds.
//
// F_strcmp and F_strcpy use the standard library frame convention. Unlike
// every function above, neither makes a TRAP or a JSR, so there is no
// TRAP-safety concern and nothing that must survive a call — R0-R3 stay live
// in registers for the whole body, with no memory locals to reserve (the
// prologue's `ADD R5,R6,#-1` line is followed directly by the two argument
// loads). Both callees follow the same signature shape: `a`/`dst` at R5+4,
// `b`/`src` at R5+5 (the two-parameter frame layout every compiled function
// with two parameters uses), return value at R5+3.
//
// F_strcmp walks both strings in lockstep (R1 over a, R2 over b), computing
// R0 - *b via negate-and-add (no SUB instruction) into R3 at each position.
// A nonzero R3 means the characters differ: R3 already holds the
// correctly-signed difference to return, exactly matching a real strcmp's
// per-character rule. A zero R3 means they matched, so R0 (still holding
// *a, untouched by the subtraction) is re-tested for the terminator — both
// strings ending at once is the only way to reach it once every earlier
// character matched.
//
// A plain signed ADD (there is no unsigned arithmetic instruction on the
// LC-3 either way) agrees with C's own unsigned-char comparison rule for
// every value in 0-255: storage is a full word with no 8-bit truncation, so
// there is no wraparound to disagree about, and a string LITERAL's own
// characters are guaranteed inside 0-127 by lexer.ts's own reportNonAscii
// guard (any source character above U+007F in a string/char literal is
// rejected at lex time) — covering getchar's raw TRAP x20 byte and every
// character scanf's %s/%c can store, both always non-negative already. The
// one place this signed reading parts from C: nothing clamps a plain
// assignment into a char (isAssignable treats int/char/bool as freely
// interconvertible, check.ts's isAssignable), so `char c = -1;` stores the
// full negative word -1 rather than 255 — a deliberately negative char
// compares as negative here where real C's unsigned-char rule would read it
// as 255.
// This subset's own library and literal paths never produce that value; a
// program that manufactures one via a bare int-to-char assignment is the
// only way to observe the divergence.
//
// F_strcpy walks dst (R1) and src (R2) together, copying one character per
// iteration and stopping the instant it copies a zero (the terminator is
// copied, not skipped, so an empty source still writes one word). STR does
// not touch the condition codes, so the BRz that decides whether to stop
// reads the flags the LDR set on the character just copied. The return
// value is dst's ORIGINAL address, reloaded from R5+4 at the end rather
// than read out of R1 (which has walked forward to the terminator's own
// address by then). No bounds checking on the destination — the same
// deliberate overrun behavior arrays have everywhere else in this compiler,
// and the same lack of size information F_scanf's own %s already has.
//
// Branch headroom: both sections are far below the range where PCoffset9
// could ever bind. Verified against the real assembler (assembling each
// section's own `asm` string in isolation and decoding every BR/LD-class
// word's low 9 bits): the whole assembled strcmp section is 26 words, worst
// branch offset -11; strcpy is 22 words, worst branch offset -6. Neither
// section contains an LD/LDI at all (no constant pool entries — no ASCII
// constant is compared against; the loop conditions test loaded characters
// and computed differences directly). Both numbers are two orders of
// magnitude under the -256..255 window, so no reach concern here for the
// foreseeable future; re-measure the same way if either function ever
// grows non-trivially (e.g. case-insensitive variants, a strncmp/strncpy
// with a length argument).

// The frame a runtime entry point sets up is exposed as metadata for callers:
// an inspection tool can render a named frame for any callee with a
// descriptor and an anonymous "runtime" frame for any without. Every
// section below carries one for each of its externally visible entries,
// transcribed from that section's own documented frame layout;
// runtimeFrames() at the bottom of this file flattens them into the one
// map the package exports.
export interface RuntimeFrameInfo {
  display: string; // e.g. 'multiply (runtime)'
  variadic?: boolean; // F_printf and F_scanf only
  params: { name: string; offset: number }[]; // R5-relative, R5+4 upward
  locals: { name: string; offset: number }[]; // R5+0 descending
}

export interface RuntimeSection {
  readonly asm: string;
  readonly needs: readonly string[];
  // Keyed by entry label (RTMUL, RTDIV, ...), not section key, because a
  // section can hold more than one externally visible entry (op-divmod).
  readonly frames?: ReadonlyMap<string, RuntimeFrameInfo>;
}

// The public heap-layout contract uses assembler symbol names,
// not addresses: callers resolve them through the assembled
// program's symbol table instead of duplicating private runtime knowledge.
export const HEAP_HEADER_WORDS = 1;
export const RTHP_BASE = 'RTHP_BASE';
export const RTHP_CEIL = 'RTHP_CEIL';
export const RTHP_HEAD = 'RTHP_HEAD';
export const RTHP_INIT = 'RTHP_INIT';

// Keyed by C function name, not the F_-mangled label, so codegen.ts's
// scan-for-JSR-F_<name> lookup and this map share one name space. `needs`
// lists other runtime function names this one calls internally via JSR (not
// TRAP) -- the transitive closure of `needs` is what actually gets spliced
// into a program, in RUNTIME_ORDER's fixed order, whenever any name in the
// closure is directly called. codegen.ts's emitRuntimeIfNeeded owns the scan
// and the closure walk; this map owns only the per-function text and its
// direct dependencies.
//
// The two operator sections are keyed 'op-mul' and 'op-divmod' -- NOT
// C function names, on purpose: a hyphenated key can never come out of the
// JSR F_<name> scan for any C identifier, so the scan can never
// false-positive on them (a user's own `int mul()` emits F_mul and matches
// nothing here). They enter a program only through explicit
// registration in the usedOpSections channel. Each lowering emitter
// records its section at the same point where it emits the corresponding
// JSR, so required runtime text and call sites cannot diverge.
//
// Each `asm` string's first line is a `; ---- <name> ----` banner.
// The banner gives emitted output an explicit boundary between user code
// and each runtime section. Its name matches the section's runtime role,
// so readers and tools can locate the start without relying on section
// size or splice position. The leading semicolon keeps it valid LC-3
// assembly text. Banner content is semantic and stable; it does not
// encode release chronology or implementation provenance and therefore
// needs no maintenance when the surrounding source changes.
export const RUNTIME_SECTIONS: ReadonlyMap<string, RuntimeSection> = new Map<
  string,
  RuntimeSection
>([
  [
    'putchar',
    {
      needs: [],
      frames: new Map([
        [
          'F_putchar',
          {
            display: 'putchar (runtime)',
            params: [{ name: 'c', offset: 4 }],
            locals: [],
          },
        ],
      ]),
      asm: `; ---- putchar ----
F_putchar
ADD R6,R6,#-1
ADD R6,R6,#-1
STR R7,R6,#0
ADD R6,R6,#-1
STR R5,R6,#0
ADD R5,R6,#-1
; no locals or temporaries to reserve
LDR R0,R5,#4
TRAP x21
STR R0,R5,#3
ADD R6,R5,#1
LDR R5,R6,#0
ADD R6,R6,#1
LDR R7,R6,#0
ADD R6,R6,#1
RET`,
    },
  ],
  [
    'getchar',
    {
      needs: [],
      // RTIO_GETCH and RTIO_UNGETCH get no descriptor on purpose: they are
      // internal helpers running under their caller's live frame (like
      // RTPF_BUMP and RTDVM_CORE), not frame-convention entries -- only
      // F_getchar is externally visible.
      frames: new Map([
        [
          'F_getchar',
          {
            display: 'getchar (runtime)',
            params: [],
            locals: [],
          },
        ],
      ]),
      asm: `; ---- getchar ----
F_getchar
ADD R6,R6,#-1
ADD R6,R6,#-1
STR R7,R6,#0
ADD R6,R6,#-1
STR R5,R6,#0
ADD R5,R6,#-1
; no locals or temporaries to reserve
; getchar routes through RTIO_GETCH, which consults the one-character
; pushback slot scanf also writes -- a character scanf looks
; ahead at and ungets is seen by the very next getchar call (18.4.2).
; GETC semantics deliberately: no echo.
; Echoing (if a program wants it) is the program's own job, e.g. via
; putchar(getchar()) -- matching IN/GETC's documented split in
; the operating-system GETC behavior.
JSR RTIO_GETCH
STR R0,R5,#3
ADD R6,R5,#1
LDR R5,R6,#0
ADD R6,R6,#1
LDR R7,R6,#0
ADD R6,R6,#1
RET
; RTIO_GETCH / RTIO_UNGETCH / RTIO_PUSHBACK: the shared one-character
; pushback slot itself -- see this file's header comment on F_scanf's
; design for why it lives here, in getchar's own section, rather than
; scanf's.
RTIO_GETCH
; Returns the pushed-back character if the slot holds one (consuming it and
; resetting the slot to empty -- input characters are non-negative, so -1
; is otherwise unreachable and safe as the empty sentinel), else falls
; through to a real TRAP x20 read. Clobbers only R0 (the return value) and
; R1 (scratch); R2/R3/R5/R6 survive untouched. R7 is safe to clobber here
; because every caller (F_getchar, F_scanf) has already saved its OWN R7 to
; its frame before ever reaching this JSR -- the same discipline RTPF_BUMP
; documents in the printf section above.
LD R0,RTIO_PUSHBACK
ADD R1,R0,#1
BRz RTIO_GETCH_TRAP
AND R1,R1,#0
ADD R1,R1,#-1
ST R1,RTIO_PUSHBACK
RET
RTIO_GETCH_TRAP
TRAP x20
RET
RTIO_UNGETCH
; Pushes the character in R0 back into the shared slot. Clobbers only R7.
; One character is provably enough for every conversion this subset's
; scanf implements (see F_scanf's design note above): nothing here ever
; ungets a second character before the first is consumed.
ST R0,RTIO_PUSHBACK
RET
RTIO_PUSHBACK .FILL #-1`,
    },
  ],
  [
    'printf',
    {
      needs: [],
      // Transcribed from the F_printf frame-layout comment in this file's
      // header. The 5-word %d digit buffer (R5-2..R5-6) is five NAMED
      // one-word slots, not one named run: a { name, offset } entry
      // describes exactly one word -- RuntimeFrameInfo has no size field --
      // so five slots is the only representation that keeps every reserved
      // word accounted for (locals.length equals the prologue's #-8
      // reserve, the invariant the descriptor-shape tests pin for every
      // section) without widening the frame descriptor interface. digit0 (R5-2)
      // receives the least-significant digit; RTPF_CONV_X reuses that word
      // as its leading-zero flag.
      frames: new Map([
        [
          'F_printf',
          {
            display: 'printf (runtime)',
            variadic: true,
            params: [{ name: 'format', offset: 4 }],
            locals: [
              { name: 'fmtPtr', offset: 0 },
              { name: 'argPtr', offset: -1 },
              { name: 'digit0', offset: -2 },
              { name: 'digit1', offset: -3 },
              { name: 'digit2', offset: -4 },
              { name: 'digit3', offset: -5 },
              { name: 'digit4', offset: -6 },
              { name: 'charCount', offset: -7 },
            ],
          },
        ],
      ]),
      asm: `; ---- printf ----
F_printf
ADD R6,R6,#-1
ADD R6,R6,#-1
STR R7,R6,#0
ADD R6,R6,#-1
STR R5,R6,#0
ADD R5,R6,#-1
ADD R6,R6,#-8
LDR R0,R5,#4
STR R0,R5,#0
ADD R0,R5,#5
STR R0,R5,#-1
AND R0,R0,#0
STR R0,R5,#-7
RTPF_LOOP
LDR R0,R5,#0
LDR R1,R0,#0
BRz RTPF_DONE
ADD R0,R0,#1
STR R0,R5,#0
LD R2,RTPF_C_NEG_PCT
ADD R2,R1,R2
BRnp RTPF_MAIN_LITERAL
LDR R0,R5,#0
LDR R1,R0,#0
ADD R0,R0,#1
STR R0,R5,#0
LD R2,RTPF_C_NEG_D
ADD R2,R1,R2
BRz RTPF_CONV_D
LD R2,RTPF_C_NEG_C
ADD R2,R1,R2
BRz RTPF_CONV_C
LD R2,RTPF_C_NEG_X
ADD R2,R1,R2
BRz RTPF_CONV_X
LD R2,RTPF_C_NEG_B
ADD R2,R1,R2
BRz RTPF_CONV_B
LD R2,RTPF_C_NEG_S
ADD R2,R1,R2
BRz RTPF_CONV_S
LD R2,RTPF_C_NEG_PCT
ADD R2,R1,R2
BRz RTPF_CONV_PCT
; Unrecognized specifier: the checker already rejects any conversion
; outside {d,c,x,b,s,%} at compile time (check.ts's PRINTF_OK_CONVERSIONS),
; so this path is defensive only. Print '%' and the specifier literally.
LD R0,RTPF_C_PCT_CHAR
TRAP x21
JSR RTPF_BUMP
ADD R0,R1,#0
TRAP x21
JSR RTPF_BUMP
BR RTPF_LOOP
RTPF_MAIN_LITERAL
ADD R0,R1,#0
TRAP x21
JSR RTPF_BUMP
BR RTPF_LOOP
RTPF_CONV_D
LDR R0,R5,#-1
LDR R1,R0,#0
ADD R0,R0,#1
STR R0,R5,#-1
LD R2,RTPF_C_INTMIN
ADD R2,R1,R2
BRnp RTPF_D_NORMAL
; R1 + (-32768) wrapped to exactly 0 -- R1 is INT_MIN, whose magnitude has
; no positive 16-bit representation. Print "-32768" literally and skip the
; normal digit-extraction path entirely.
LD R1,RTPF_C_INTMIN_STR
; This print-until-zero loop is byte-for-byte identical to RTPF_S_LOOP further
; below -- both walk a NUL-terminated span starting in
; R1. Deliberately not shared (that would couple two independent conversions
; for six words, and sharing six words is not worth the coupling); if you change one, check
; whether the other needs the same change.
RTPF_D_INTMIN_LOOP
LDR R0,R1,#0
BRz RTPF_LOOP
TRAP x21
JSR RTPF_BUMP
ADD R1,R1,#1
BR RTPF_D_INTMIN_LOOP
RTPF_D_NORMAL
ADD R2,R1,#0
BRzp RTPF_D_DIGITS
LD R0,RTPF_C_MINUS
TRAP x21
JSR RTPF_BUMP
NOT R1,R1
ADD R1,R1,#1
RTPF_D_DIGITS
; R1 is now >= 0 (never INT_MIN -- diverted above), so this negation is
; always safe. Peel decimal digits off R1 least-significant-first via
; repeated subtraction of 10 (no DIV instruction), writing each into the
; 5-word buffer at R5-2..R5-6 from the low end up; R3 is the buffer write
; pointer, R2 the digit count.
ADD R3,R5,#-2
AND R2,R2,#0
RTPF_D_DIGLOOP
AND R0,R0,#0
RTPF_D_SUB10
ADD R1,R1,#-10
BRn RTPF_D_GOTDIGIT
ADD R0,R0,#1
BR RTPF_D_SUB10
RTPF_D_GOTDIGIT
ADD R1,R1,#10
STR R1,R3,#0
ADD R3,R3,#-1
ADD R2,R2,#1
ADD R1,R0,#0
BRp RTPF_D_DIGLOOP
ADD R3,R3,#1
RTPF_D_PRINTLOOP
LDR R1,R3,#0
LD R0,RTPF_C_ZERO
ADD R0,R1,R0
TRAP x21
JSR RTPF_BUMP
ADD R3,R3,#1
ADD R2,R2,#-1
BRp RTPF_D_PRINTLOOP
BR RTPF_LOOP
RTPF_CONV_C
LDR R0,R5,#-1
LDR R1,R0,#0
ADD R0,R0,#1
STR R0,R5,#-1
ADD R0,R1,#0
TRAP x21
JSR RTPF_BUMP
BR RTPF_LOOP
RTPF_CONV_X
LDR R0,R5,#-1
LDR R1,R0,#0
ADD R0,R0,#1
STR R0,R5,#-1
AND R2,R2,#0
ADD R2,R2,#4
; %x is unpadded lowercase hexadecimal (book section 11.5.4; Appendix D
; Table D.6 / D.9.1.4), so leading zero nibbles are suppressed and the
; returned character count is the number of digits actually written -- the
; same leading-zero discipline RTPF_CONV_D uses for decimal, including the
; "a zero value still prints a single 0" special case. R5-2 (a word of the
; %d digit buffer, unused by %x) is a flag: 0 until the first significant
; nibble is emitted, nonzero after, so trailing zeros still print.
AND R0,R0,#0
STR R0,R5,#-2
RTPF_X_NIBLOOP
; Four bits per nibble, MSB first: test R1's sign (bit 15), fold it into
; the R3 accumulator, then double R1 (drops the just-tested bit, brings
; the next one into sign position) -- the same trick codegen.ts's right
; shift lowering uses, run forward instead of building a shifted result.
AND R3,R3,#0
ADD R0,R1,#0
BRzp RTPF_X_A0
ADD R3,R3,#1
RTPF_X_A0
ADD R1,R1,R1
ADD R3,R3,R3
ADD R0,R1,#0
BRzp RTPF_X_B0
ADD R3,R3,#1
RTPF_X_B0
ADD R1,R1,R1
ADD R3,R3,R3
ADD R0,R1,#0
BRzp RTPF_X_C0
ADD R3,R3,#1
RTPF_X_C0
ADD R1,R1,R1
ADD R3,R3,R3
ADD R0,R1,#0
BRzp RTPF_X_D0
ADD R3,R3,#1
RTPF_X_D0
ADD R1,R1,R1
; Emit this nibble if a significant one has already been seen (flag set)
; or this nibble is itself significant; otherwise it is a leading zero,
; skip it (mirrors RTPF_CONV_D suppressing leading decimal zeros).
LDR R0,R5,#-2
BRnp RTPF_X_DOEMIT
ADD R0,R3,#0
BRz RTPF_X_NEXT
RTPF_X_DOEMIT
AND R0,R0,#0
ADD R0,R0,#1
STR R0,R5,#-2
ADD R0,R3,#-10
BRn RTPF_X_ISDIG
LD R0,RTPF_C_HEXBASE_ALPHA
ADD R0,R3,R0
BR RTPF_X_EMIT
RTPF_X_ISDIG
LD R0,RTPF_C_ZERO
ADD R0,R3,R0
RTPF_X_EMIT
TRAP x21
JSR RTPF_BUMP
RTPF_X_NEXT
ADD R2,R2,#-1
BRp RTPF_X_NIBLOOP
; If no nibble was ever emitted the value was 0: print a single '0'.
LDR R0,R5,#-2
BRnp RTPF_LOOP
LD R0,RTPF_C_ZERO
TRAP x21
JSR RTPF_BUMP
BR RTPF_LOOP
RTPF_CONV_B
LDR R0,R5,#-1
LDR R1,R0,#0
ADD R0,R0,#1
STR R0,R5,#-1
AND R2,R2,#0
ADD R2,R2,#15
ADD R2,R2,#1
RTPF_B_LOOP
ADD R0,R1,#0
BRzp RTPF_B_ZERO
LD R0,RTPF_C_ONE_CHAR
BR RTPF_B_EMIT
RTPF_B_ZERO
LD R0,RTPF_C_ZERO
RTPF_B_EMIT
TRAP x21
JSR RTPF_BUMP
ADD R1,R1,R1
ADD R2,R2,#-1
BRp RTPF_B_LOOP
BR RTPF_LOOP
RTPF_CONV_S
; The vararg itself is the string's address (unlike %c, whose vararg IS the
; value to print) -- one bump of argPtr, same as every other conversion,
; then walk memory from that address printing characters until a zero
; terminator, counting every one of them via RTPF_BUMP.
LDR R0,R5,#-1
LDR R1,R0,#0
ADD R0,R0,#1
STR R0,R5,#-1
; This print-until-zero loop is byte-for-byte identical to RTPF_D_INTMIN_LOOP
; above (RTPF_CONV_D's -32768 special case) -- both walk a NUL-terminated span
; starting in R1. Deliberately not shared (that would couple two independent
; conversions for six words, and sharing six words is not worth the coupling); if you change
; one, check whether the other needs the same change.
RTPF_S_LOOP
LDR R0,R1,#0
BRz RTPF_LOOP
TRAP x21
JSR RTPF_BUMP
ADD R1,R1,#1
BR RTPF_S_LOOP
RTPF_CONV_PCT
LD R0,RTPF_C_PCT_CHAR
TRAP x21
JSR RTPF_BUMP
BR RTPF_LOOP
RTPF_DONE
; Return the running character count. printf returning
; a negative value is reserved exclusively for errors (Appendix D section
; D.9.1.4), which the supported I/O model never produces. RTPF_BUMP keeps the
; count saturated at INT_MAX (32767) on EVERY character, so it is already in
; [0, 32767] here regardless of how many characters a single call emitted --
; the 16-bit count word can never wrap (once, twice, or more), so no end-only
; guard is needed and the return is never negative.
LDR R0,R5,#-7
STR R0,R5,#3
ADD R6,R5,#1
LDR R5,R6,#0
ADD R6,R6,#1
LDR R7,R6,#0
ADD R6,R6,#1
RET
RTPF_BUMP
; Saturating increment of the character count word at R5-7 (printf's running
; return value). The count only ever rises by 1, so the first increment that
; would overshoot INT_MAX produces 0x8000 (negative); clamp it back to 32767.
; Because it self-corrects on every attempt, the word can never exceed 32767
; and so can never wrap into the negative error range -- true for one wrap,
; two wraps, or more. Clobbers only R0 (dead at every
; call site) and R7 (dead in the body until the epilogue reloads it from the
; frame), so each conversion loop's live values in R1-R3 survive the call.
LDR R0,R5,#-7
ADD R0,R0,#1
BRzp RTPF_BUMP_STORE
LD R0,RTPF_C_MAX
RTPF_BUMP_STORE
STR R0,R5,#-7
RET
RTPF_C_NEG_PCT .FILL #-37
RTPF_C_NEG_D .FILL #-100
RTPF_C_NEG_C .FILL #-99
RTPF_C_NEG_X .FILL #-120
RTPF_C_NEG_B .FILL #-98
RTPF_C_NEG_S .FILL #-115
RTPF_C_PCT_CHAR .FILL #37
RTPF_C_ZERO .FILL #48
RTPF_C_ONE_CHAR .FILL #49
RTPF_C_MINUS .FILL #45
RTPF_C_HEXBASE_ALPHA .FILL #87
RTPF_C_INTMIN .FILL #-32768
RTPF_C_INTMIN_STR .FILL RTPF_INTMIN_TXT
RTPF_C_MAX .FILL #32767
RTPF_INTMIN_TXT .STRINGZ "-32768"`,
    },
  ],
  [
    'scanf',
    {
      needs: ['getchar'],
      // Transcribed from the F_scanf frame-layout comment in this file's
      // header: the four memory locals the prologue's #-4 reserves.
      frames: new Map([
        [
          'F_scanf',
          {
            display: 'scanf (runtime)',
            variadic: true,
            params: [{ name: 'format', offset: 4 }],
            locals: [
              { name: 'fmtPtr', offset: 0 },
              { name: 'argPtr', offset: -1 },
              { name: 'assignCount', offset: -2 },
              { name: 'digitSeen', offset: -3 },
            ],
          },
        ],
      ]),
      asm: `; ---- scanf ----
F_scanf
ADD R6,R6,#-1
ADD R6,R6,#-1
STR R7,R6,#0
ADD R6,R6,#-1
STR R5,R6,#0
ADD R5,R6,#-1
ADD R6,R6,#-4
LDR R0,R5,#4
STR R0,R5,#0
ADD R0,R5,#5
STR R0,R5,#-1
AND R0,R0,#0
STR R0,R5,#-2
RTSC_LOOP
LDR R0,R5,#0
LDR R1,R0,#0
BRz RTSC_DONE
ADD R0,R0,#1
STR R0,R5,#0
; Classify the format character just consumed: '%' introduces a
; conversion, whitespace (space/tab/newline) matches zero or more
; whitespace characters in the input (RTSC_SKIPWS), and anything else is a
; literal that must match the next input character exactly (RTSC_LITERAL).
; None of these four comparisons touches R1, so it still holds the format
; character however this falls through to RTSC_LITERAL below.
LD R2,RTSC_C_NEG_PCT
ADD R2,R1,R2
BRz RTSC_SPEC
LD R2,RTSC_C_NEG_SPACE
ADD R2,R1,R2
BRz RTSC_SKIPWS
LD R2,RTSC_C_NEG_TAB
ADD R2,R1,R2
BRz RTSC_SKIPWS
LD R2,RTSC_C_NEG_NL
ADD R2,R1,R2
BRz RTSC_SKIPWS
BR RTSC_LITERAL
RTSC_SPEC
; R1 held '%'; read the spec character that follows it.
LDR R0,R5,#0
LDR R1,R0,#0
ADD R0,R0,#1
STR R0,R5,#0
LD R2,RTSC_C_NEG_PCT
ADD R2,R1,R2
BRz RTSC_LITERAL
LD R2,RTSC_C_NEG_D
ADD R2,R1,R2
BRz RTSC_CONV_D
LD R2,RTSC_C_NEG_C
ADD R2,R1,R2
BRz RTSC_CONV_C
LD R2,RTSC_C_NEG_S
ADD R2,R1,R2
BRz RTSC_CONV_S
; Unreachable per the checker (defensive only, mirrors printf's own
; defensive fallback for an unrecognized specifier): skip it and continue.
BR RTSC_LOOP
RTSC_SKIPWS
; Read and discard input characters one at a time while they are
; whitespace, then push back the first one that is not -- it belongs to
; whatever the format asks for next. Zero matching input characters (the
; very first one read is already non-whitespace) is success, not failure:
; this is "zero or more", never a mismatch.
JSR RTIO_GETCH
LD R2,RTSC_C_NEG_SPACE
ADD R2,R0,R2
BRz RTSC_SKIPWS
LD R2,RTSC_C_NEG_TAB
ADD R2,R0,R2
BRz RTSC_SKIPWS
LD R2,RTSC_C_NEG_NL
ADD R2,R0,R2
BRz RTSC_SKIPWS
JSR RTIO_UNGETCH
BR RTSC_LOOP
RTSC_LITERAL
; A literal non-whitespace format character matches the input exactly, with
; no skipping in front of it -- see this file's header comment on the book
; divergence this rule carries. Move R1 (the format character) into R3
; before calling RTIO_GETCH, which clobbers R1 as scratch; R3 survives.
ADD R3,R1,#0
JSR RTIO_GETCH
NOT R2,R3
ADD R2,R2,#1
ADD R2,R0,R2
BRz RTSC_LOOP
; Mismatch: push the offending character back for whoever reads next (a
; later conversion, or the caller's own getchar) and abandon the rest of
; the format -- every conversion still to come is skipped, and scanf
; returns however many assignments already succeeded (D.9.1.3).
JSR RTIO_UNGETCH
BR RTSC_DONE
RTSC_CONV_C
; %c does NOT skip whitespace -- reads exactly the next character.
JSR RTIO_GETCH
LDR R1,R5,#-1
LDR R1,R1,#0
STR R0,R1,#0
LDR R1,R5,#-1
ADD R1,R1,#1
STR R1,R5,#-1
LDR R1,R5,#-2
ADD R1,R1,#1
STR R1,R5,#-2
BR RTSC_LOOP
RTSC_CONV_D
RTSC_D_SKIPWS
JSR RTIO_GETCH
LD R1,RTSC_C_NEG_SPACE
ADD R1,R0,R1
BRz RTSC_D_SKIPWS
LD R1,RTSC_C_NEG_TAB
ADD R1,R0,R1
BRz RTSC_D_SKIPWS
LD R1,RTSC_C_NEG_NL
ADD R1,R0,R1
BRz RTSC_D_SKIPWS
AND R3,R3,#0
LD R1,RTSC_C_NEG_MINUS
ADD R1,R0,R1
BRnp RTSC_D_CHECKPLUS
ADD R3,R3,#1
JSR RTIO_GETCH
BR RTSC_D_FIRSTDIGIT
RTSC_D_CHECKPLUS
LD R1,RTSC_C_NEG_PLUS
ADD R1,R0,R1
BRnp RTSC_D_FIRSTDIGIT
JSR RTIO_GETCH
RTSC_D_FIRSTDIGIT
AND R2,R2,#0
; R5-3 is a digit-seen flag, local to this one conversion: 0 until the
; first digit is accumulated, so RTSC_D_DONE_DIGITS below can tell a
; genuine number apart from a matching failure (no digit ever seen) even
; though both cases can leave the accumulator at exactly 0.
AND R1,R1,#0
STR R1,R5,#-3
RTSC_D_DIGLOOP
LD R1,RTSC_C_NEG_ZERO
ADD R1,R0,R1
BRn RTSC_D_DONE_DIGITS
ADD R1,R1,#-10
BRzp RTSC_D_DONE_DIGITS
ADD R1,R1,#10
; R0 (the just-confirmed digit character) is dead from here on -- its
; value is already captured as R1 -- so it is free to mark the flag before
; being reused as multiply-by-10 scratch below.
AND R0,R0,#0
ADD R0,R0,#1
STR R0,R5,#-3
ADD R0,R2,R2
ADD R2,R2,R2
ADD R2,R2,R2
ADD R2,R2,R2
ADD R2,R2,R0
ADD R2,R2,R1
JSR RTIO_GETCH
BR RTSC_D_DIGLOOP
RTSC_D_DONE_DIGITS
JSR RTIO_UNGETCH
; A matching failure -- no digit was ever consumed, whether or not a sign
; character was -- aborts the entire scan without storing or counting,
; exactly like RTSC_LITERAL's own mismatch path.
LDR R1,R5,#-3
BRz RTSC_DONE
ADD R1,R3,#0
BRz RTSC_D_STORE
NOT R2,R2
ADD R2,R2,#1
RTSC_D_STORE
LDR R1,R5,#-1
LDR R1,R1,#0
STR R2,R1,#0
LDR R1,R5,#-1
ADD R1,R1,#1
STR R1,R5,#-1
LDR R1,R5,#-2
ADD R1,R1,#1
STR R1,R5,#-2
BR RTSC_LOOP
RTSC_CONV_S
; %s reads a whitespace-delimited token into the destination char array
; (the vararg's own address, exactly like %c's destination) and
; NUL-terminates it. R3 is the write pointer for the duration of this
; conversion -- a register, like %d's sign flag R3 above, because it must
; survive JSR RTIO_GETCH, which clobbers only R0/R1. No field-width syntax
; exists in this subset, so a token longer than the destination array
; overruns it -- the same overrun behavior arrays have everywhere else in
; this compiler, and deliberately not guarded against here.
LDR R1,R5,#-1
LDR R3,R1,#0
RTSC_S_SKIPWS
JSR RTIO_GETCH
LD R1,RTSC_C_NEG_SPACE
ADD R1,R0,R1
BRz RTSC_S_SKIPWS
LD R1,RTSC_C_NEG_TAB
ADD R1,R0,R1
BRz RTSC_S_SKIPWS
LD R1,RTSC_C_NEG_NL
ADD R1,R0,R1
BRz RTSC_S_SKIPWS
RTSC_S_LOOP
STR R0,R3,#0
ADD R3,R3,#1
JSR RTIO_GETCH
LD R1,RTSC_C_NEG_SPACE
ADD R1,R0,R1
BRz RTSC_S_DONE
LD R1,RTSC_C_NEG_TAB
ADD R1,R0,R1
BRz RTSC_S_DONE
LD R1,RTSC_C_NEG_NL
ADD R1,R0,R1
BRz RTSC_S_DONE
BR RTSC_S_LOOP
RTSC_S_DONE
; R1 is already 0 here, from whichever of the three comparisons above just
; matched (BRz only fires when the sum is exactly zero) -- store it as the
; NUL terminator directly rather than re-zeroing a register that already
; is. Written BEFORE the JSR below on purpose: RTIO_UNGETCH's own clobber
; contract only promises R7, but writing the terminator first means this
; code depends on that promise for R7 alone, not for R1 as well.
STR R1,R3,#0
JSR RTIO_UNGETCH
LDR R1,R5,#-1
ADD R1,R1,#1
STR R1,R5,#-1
LDR R1,R5,#-2
ADD R1,R1,#1
STR R1,R5,#-2
BR RTSC_LOOP
RTSC_DONE
LDR R0,R5,#-2
STR R0,R5,#3
ADD R6,R5,#1
LDR R5,R6,#0
ADD R6,R6,#1
LDR R7,R6,#0
ADD R6,R6,#1
RET
RTSC_C_NEG_D .FILL #-100
RTSC_C_NEG_C .FILL #-99
RTSC_C_NEG_S .FILL #-115
RTSC_C_NEG_PCT .FILL #-37
RTSC_C_NEG_SPACE .FILL #-32
RTSC_C_NEG_TAB .FILL #-9
RTSC_C_NEG_NL .FILL #-10
RTSC_C_NEG_MINUS .FILL #-45
RTSC_C_NEG_PLUS .FILL #-43
RTSC_C_NEG_ZERO .FILL #-48`,
    },
  ],
  [
    'strcmp',
    {
      needs: [],
      // The section's own names (a walked by R1, b by R2 -- RTCMP_LOOP's
      // comment and the two-parameter layout note in this file's header):
      // a at R5+4, b at R5+5, no memory locals.
      frames: new Map([
        [
          'F_strcmp',
          {
            display: 'strcmp (runtime)',
            params: [
              { name: 'a', offset: 4 },
              { name: 'b', offset: 5 },
            ],
            locals: [],
          },
        ],
      ]),
      asm: `; ---- strcmp ----
F_strcmp
ADD R6,R6,#-1
ADD R6,R6,#-1
STR R7,R6,#0
ADD R6,R6,#-1
STR R5,R6,#0
ADD R5,R6,#-1
; no locals or temporaries to reserve -- unlike printf/scanf, this body
; makes no TRAP and no JSR, so nothing here needs to survive one; every
; live value stays in a register for the whole function.
LDR R1,R5,#4
LDR R2,R5,#5
RTCMP_LOOP
; Compare *a (via R1) against *b (via R2) one character at a time. Storage
; is a full word with no 8-bit truncation, so an ordinary signed ADD agrees
; with C's unsigned-char comparison rule for every value in 0-255 -- which
; covers a string literal's own characters (lexer.ts rejects anything above
; U+007F at lex time) and every character getchar/scanf can store. See this
; file's header note above for the one case (a char deliberately assigned a
; negative int value) where a signed reading parts from C.
LDR R0,R1,#0
LDR R3,R2,#0
NOT R3,R3
ADD R3,R3,#1
ADD R3,R0,R3
BRnp RTCMP_DONE
; R3 is exactly 0 here: *a and *b matched. Re-test R0 (still holding *a,
; untouched by the subtraction above) for the terminator -- equal AND
; both zero means the strings matched all the way to their end.
ADD R0,R0,#0
BRz RTCMP_DONE
ADD R1,R1,#1
ADD R2,R2,#1
BR RTCMP_LOOP
RTCMP_DONE
STR R3,R5,#3
ADD R6,R5,#1
LDR R5,R6,#0
ADD R6,R6,#1
LDR R7,R6,#0
ADD R6,R6,#1
RET`,
    },
  ],
  [
    'strcpy',
    {
      needs: [],
      // The section's own names (dst walked by R1, src by R2 -- RTCPY_LOOP's
      // comment and the two-parameter layout note in this file's header):
      // dst at R5+4, src at R5+5, no memory locals.
      frames: new Map([
        [
          'F_strcpy',
          {
            display: 'strcpy (runtime)',
            params: [
              { name: 'dst', offset: 4 },
              { name: 'src', offset: 5 },
            ],
            locals: [],
          },
        ],
      ]),
      asm: `; ---- strcpy ----
F_strcpy
ADD R6,R6,#-1
ADD R6,R6,#-1
STR R7,R6,#0
ADD R6,R6,#-1
STR R5,R6,#0
ADD R5,R6,#-1
; no locals or temporaries to reserve -- same reasoning as F_strcmp above.
LDR R1,R5,#4
LDR R2,R5,#5
RTCPY_LOOP
; Copy one character from *src (R2) to *dst (R1), through the terminator.
; STR does not touch the condition codes, so the BRz below still reads the
; flags the LDR just set from the copied character -- stop right after
; writing the terminator, not before. No bounds checking, the same
; deliberate overrun behavior arrays have everywhere else in this
; compiler, and scanf's own unbounded %s already relies on.
LDR R0,R2,#0
STR R0,R1,#0
BRz RTCPY_DONE
ADD R1,R1,#1
ADD R2,R2,#1
BR RTCPY_LOOP
RTCPY_DONE
; strcpy returns dst -- reload the ORIGINAL argument at R5+4, not R1,
; which has been walked forward to the terminator's own address.
LDR R0,R5,#4
STR R0,R5,#3
ADD R6,R5,#1
LDR R5,R6,#0
ADD R6,R6,#1
LDR R7,R6,#0
ADD R6,R6,#1
RET`,
    },
  ],
  [
    'op-mul',
    {
      needs: [],
      frames: new Map([
        [
          'RTMUL',
          {
            display: 'multiply (runtime)',
            params: [
              { name: 'left', offset: 4 },
              { name: 'right', offset: 5 },
            ],
            locals: [],
          },
        ],
      ]),
      asm: `; ---- op-mul ----
; Multiplication uses repeated addition under the runtime calling
; convention. Zero returns zero. A negative counter negates both operands;
; ordinary negative magnitudes count down from positive, while INT_MIN
; wraps to 32767 after its first decrement and still performs 32768
; iterations. Each iteration accumulates the left operand into the product.
; Fixed RTMUL_ labels keep helper symbols disjoint from user functions.
; The caller pushes right then left, so left sits
; at R5+4 and right at R5+5, exactly where a two-parameter function's
; arguments land; the product goes to the R5+3 return slot. Registers
; R0-R3 only -- no TRAP, no internal JSR, no locals.
; The assembly tests pin branch headroom by assembling this section:
; 30 words, worst PCoffset9 reference +12 (the
; BRz to RTMUL_ZERO); no LD-class references at all (no constant pool).
RTMUL
ADD R6,R6,#-1
ADD R6,R6,#-1
STR R7,R6,#0
ADD R6,R6,#-1
STR R5,R6,#0
ADD R5,R6,#-1
; no locals or temporaries to reserve
LDR R1,R5,#4
LDR R0,R5,#5
ADD R0,R0,#0
BRz RTMUL_ZERO
BRn RTMUL_NEG
BR RTMUL_POS
RTMUL_NEG
NOT R1,R1
ADD R1,R1,#1
NOT R0,R0
ADD R0,R0,#1
RTMUL_POS
AND R2,R2,#0
RTMUL_LOOP
ADD R2,R2,R1
ADD R0,R0,#-1
BRp RTMUL_LOOP
ADD R0,R2,#0
BR RTMUL_DONE
RTMUL_ZERO
AND R0,R0,#0
RTMUL_DONE
STR R0,R5,#3
ADD R6,R5,#1
LDR R5,R6,#0
ADD R6,R6,#1
LDR R7,R6,#0
ADD R6,R6,#1
RET`,
    },
  ],
  [
    'op-divmod',
    {
      needs: [],
      frames: new Map([
        [
          'RTDIV',
          {
            display: 'divide (runtime)',
            params: [
              { name: 'dividend', offset: 4 },
              { name: 'divisor', offset: 5 },
            ],
            locals: [
              { name: 'dsign', offset: 0 },
              { name: 'vsign', offset: -1 },
            ],
          },
        ],
        [
          'RTMOD',
          {
            display: 'modulus (runtime)',
            params: [
              { name: 'dividend', offset: 4 },
              { name: 'divisor', offset: 5 },
            ],
            locals: [
              { name: 'dsign', offset: 0 },
              { name: 'vsign', offset: -1 },
            ],
          },
        ],
      ]),
      asm: `; ---- op-divmod ----
; The / and % operators share one runtime section. Divide and modulus
; are one computation with two answers, so two complete frame-convention
; entries (RTDIV, RTMOD) sit over one internal core -- the same
; section-hosts-helpers shape getchar's section uses for RTIO_GETCH and
; RTIO_UNGETCH. Each entry reserves the two sign slots used by the core:
; dsign at R5+0 and vsign at R5-1. It loads the dividend
; from R5+4 (the left, pushed-last argument) into R1 and the divisor
; from R5+5 into R0, calls the core, and stores the selected answer --
; quotient for RTDIV, remainder for RTMOD -- in the R5+3 return slot.
; The assembly tests pin branch headroom by assembling this section:
; 77 words, worst PCoffset9 reference -7 (BR RTDVM_LOOP), and
; no LD-class references or constant pool. The two internal JSRs
; target RTDVM_CORE at PCoffset11 +24 and +7, both far inside
; the signed -1024..1023 window; no long-call trampoline is
; required.
RTDIV
ADD R6,R6,#-1
ADD R6,R6,#-1
STR R7,R6,#0
ADD R6,R6,#-1
STR R5,R6,#0
ADD R5,R6,#-1
ADD R6,R6,#-2
LDR R1,R5,#4
LDR R0,R5,#5
JSR RTDVM_CORE
STR R2,R5,#3
ADD R6,R5,#1
LDR R5,R6,#0
ADD R6,R6,#1
LDR R7,R6,#0
ADD R6,R6,#1
RET
RTMOD
ADD R6,R6,#-1
ADD R6,R6,#-1
STR R7,R6,#0
ADD R6,R6,#-1
STR R5,R6,#0
ADD R5,R6,#-1
ADD R6,R6,#-2
LDR R1,R5,#4
LDR R0,R5,#5
JSR RTDVM_CORE
STR R1,R5,#3
ADD R6,R5,#1
LDR R5,R6,#0
ADD R6,R6,#1
LDR R7,R6,#0
ADD R6,R6,#1
RET
RTDVM_CORE
; Division and modulus share one repeated-subtraction core.
; Quotient truncates toward zero, and remainder takes the dividend's sign.
; The core records operand signs, normalizes magnitudes, subtracts until
; completion, then reapplies the dividend sign to the remainder and the
; combined operand sign to the quotient. Fixed RTDVM_ labels keep internal
; symbols disjoint; R5+0/R5-1 hold sign flags in the active runtime frame.
; On entry R1 is the dividend and R0 is the divisor; the core returns
; quotient in R2 and remainder in R1, both signed. It runs under the active
; runtime frame and clobbers R7, so each caller saves its own R7 before
; entering the core, matching the nested-call discipline used throughout.
; A zero divisor never terminates because subtracting zero cannot reduce
; the dividend magnitude. check.ts rejects compile-time-constant zero, but a
; runtime value of zero can still reach this path and retain the same
; nonterminating semantics.
ADD R1,R1,#0
BRn RTDVM_DSIGN_NEG
AND R2,R2,#0
BR RTDVM_DSIGN_DONE
RTDVM_DSIGN_NEG
AND R2,R2,#0
ADD R2,R2,#1
RTDVM_DSIGN_DONE
STR R2,R5,#0
ADD R0,R0,#0
BRn RTDVM_VSIGN_NEG
AND R2,R2,#0
BR RTDVM_VSIGN_DONE
RTDVM_VSIGN_NEG
AND R2,R2,#0
ADD R2,R2,#1
RTDVM_VSIGN_DONE
STR R2,R5,#-1
ADD R1,R1,#0
BRzp RTDVM_DVD_POS
NOT R1,R1
ADD R1,R1,#1
RTDVM_DVD_POS
ADD R0,R0,#0
BRzp RTDVM_DVSR_POS
NOT R0,R0
ADD R0,R0,#1
RTDVM_DVSR_POS
AND R2,R2,#0
RTDVM_LOOP
NOT R3,R0
ADD R3,R3,#1
ADD R3,R1,R3
BRn RTDVM_STOP
ADD R1,R3,#0
ADD R2,R2,#1
BR RTDVM_LOOP
RTDVM_STOP
LDR R3,R5,#0
ADD R3,R3,#0
BRz RTDVM_REM_DONE
NOT R1,R1
ADD R1,R1,#1
RTDVM_REM_DONE
LDR R3,R5,#0
LDR R0,R5,#-1
ADD R3,R3,R0
ADD R3,R3,#-1
BRnp RTDVM_QUOT_DONE
NOT R2,R2
ADD R2,R2,#1
RTDVM_QUOT_DONE
RET`,
    },
  ],
  [
    'malloc',
    {
      needs: [],
      frames: new Map([
        [
          'F_malloc',
          {
            display: 'malloc (runtime)',
            params: [{ name: 'bytes', offset: 4 }],
            locals: [{ name: 'words', offset: 0 }],
          },
        ],
      ]),
      asm: `; ---- malloc ----
; The first-fit heap allocator represents each block with one size header
; followed by payload words; a free block's first payload word is its next
; link. Header sizes and addresses are unsigned 16-bit facts because the
; real [IMAGE_END,xE000) heap can exceed x7FFF words and cross x8000.
;
; Full callee frame: bytes at R5+4, rounded word count at R5+0, result at
; R5+3. During the first-fit walk R0=current header, R1=previous header,
; and R2/R3 are scratch. RTHP_ULT is the private unsigned comparison helper
; shared with free: R2=a, R3=b; it preserves R0-R2, returns R3=1/P exactly
; when a<b unsigned and R3=0/Z otherwise, and clobbers R7. This entry saved
; its caller's R7 before any helper call, as the full convention requires.
; Dependency-aware assembly pins branch headroom at
; 104 words, worst PCoffset9 +95, and worst JSR PCoffset11 +45.
F_malloc
ADD R6,R6,#-1
ADD R6,R6,#-1
STR R7,R6,#0
ADD R6,R6,#-1
STR R5,R6,#0
ADD R5,R6,#-1
ADD R6,R6,#-1
; Initialize before inspecting the request, including malloc(0).
LD R0,${RTHP_INIT}
BRnp RTHP_M_READY
AND R0,R0,#0
ADD R0,R0,#1
ST R0,${RTHP_INIT}
LD R0,${RTHP_BASE}
LD R1,${RTHP_CEIL}
NOT R2,R0
ADD R2,R2,#1
ADD R2,R1,R2
; A zero- or one-word region cannot hold both header and free-list link.
BRz RTHP_M_INIT_EMPTY
ADD R2,R2,#-1
BRz RTHP_M_INIT_EMPTY
STR R2,R0,#0
AND R1,R1,#0
STR R1,R0,#1
ST R0,${RTHP_HEAD}
BR RTHP_M_READY
RTHP_M_INIT_EMPTY
AND R0,R0,#0
ST R0,${RTHP_HEAD}
RTHP_M_READY
LDR R0,R5,#4
BRnz RTHP_M_FAIL
; ceil(bytes/2), visibly, without depending on RTDIV.
AND R2,R2,#0
RTHP_M_ROUND
ADD R2,R2,#1
ADD R0,R0,#-2
BRp RTHP_M_ROUND
STR R2,R5,#0
LD R0,${RTHP_HEAD}
AND R1,R1,#0
RTHP_M_WALK
ADD R0,R0,#0
BRz RTHP_M_FAIL
LDR R2,R0,#0
LDR R3,R5,#0
JSR RTHP_ULT
BRp RTHP_M_ADVANCE
; R2 = unsigned size-request. Fit is already established by RTHP_ULT.
LDR R2,R0,#0
LDR R3,R5,#0
NOT R3,R3
ADD R3,R3,#1
ADD R2,R2,R3
ADD R3,R2,#0
BRz RTHP_M_WHOLE
ADD R3,R2,#-1
BRz RTHP_M_WHOLE
; Split: selected header stays allocated; remainder starts after its payload.
LDR R3,R5,#0
ADD R3,R3,#1
ADD R3,R0,R3
ADD R2,R2,#-1
STR R2,R3,#0
LDR R2,R0,#1
STR R2,R3,#1
ADD R1,R1,#0
BRz RTHP_M_SPLIT_HEAD
STR R3,R1,#1
BR RTHP_M_SPLIT_LINKED
RTHP_M_SPLIT_HEAD
ST R3,${RTHP_HEAD}
RTHP_M_SPLIT_LINKED
LDR R2,R5,#0
STR R2,R0,#0
BR RTHP_M_SUCCESS
; Residual zero or one: consume the whole block and retain its true size.
RTHP_M_WHOLE
LDR R2,R0,#1
ADD R1,R1,#0
BRz RTHP_M_WHOLE_HEAD
STR R2,R1,#1
BR RTHP_M_SUCCESS
RTHP_M_WHOLE_HEAD
ST R2,${RTHP_HEAD}
BR RTHP_M_SUCCESS
RTHP_M_ADVANCE
ADD R1,R0,#0
LDR R0,R0,#1
BR RTHP_M_WALK
RTHP_M_SUCCESS
ADD R0,R0,#1
BR RTHP_M_DONE
RTHP_M_FAIL
AND R0,R0,#0
RTHP_M_DONE
STR R0,R5,#3
ADD R6,R5,#1
LDR R5,R6,#0
ADD R6,R6,#1
LDR R7,R6,#0
ADD R6,R6,#1
RET
; Unsigned R2<R3, preserving R0-R2 and returning both value and CC in R3.
RTHP_ULT
ADD R2,R2,#0
BRn RTHP_ULT_A_HIGH
ADD R3,R3,#0
BRn RTHP_ULT_TRUE
BR RTHP_ULT_SAME_HALF
RTHP_ULT_A_HIGH
ADD R3,R3,#0
BRzp RTHP_ULT_FALSE
RTHP_ULT_SAME_HALF
NOT R3,R3
ADD R3,R3,#1
ADD R3,R2,R3
BRn RTHP_ULT_TRUE
RTHP_ULT_FALSE
AND R3,R3,#0
RET
RTHP_ULT_TRUE
AND R3,R3,#0
ADD R3,R3,#1
RET
${RTHP_HEAD} .FILL #0
${RTHP_INIT} .FILL #0`,
    },
  ],
  [
    'free',
    {
      needs: ['malloc'],
      frames: new Map([
        [
          'F_free',
          {
            display: 'free (runtime)',
            params: [{ name: 'p', offset: 4 }],
            locals: [],
          },
        ],
      ]),
      asm: `; ---- free ----
; Address-ordered insertion followed by right-then-left coalescing:
; R0=freed block header, R1=previous free block, R2=next free
; block, R3=scratch. RTHP_ULT and RTHP_HEAD live in malloc, hence the
; section's one-way dependency. free(0) returns without touching heap state;
; every other pointer is trusted exactly as supplied, with no validity check.
; The branch-headroom calculation includes malloc:
; 63 words, worst PCoffset9 +49, cross-section JSR PCoffset11 -35.
F_free
ADD R6,R6,#-1
ADD R6,R6,#-1
STR R7,R6,#0
ADD R6,R6,#-1
STR R5,R6,#0
ADD R5,R6,#-1
; no locals or temporaries to reserve
LDR R0,R5,#4
BRz RTHP_F_DONE
ADD R0,R0,#-1
AND R1,R1,#0
LD R2,${RTHP_HEAD}
RTHP_F_WALK
ADD R2,R2,#0
BRz RTHP_F_INSERT
ADD R3,R0,#0
JSR RTHP_ULT
BRz RTHP_F_INSERT
ADD R1,R2,#0
LDR R2,R2,#1
BR RTHP_F_WALK
RTHP_F_INSERT
STR R2,R0,#1
ADD R1,R1,#0
BRz RTHP_F_NEW_HEAD
STR R0,R1,#1
BR RTHP_F_RIGHT
RTHP_F_NEW_HEAD
ST R0,${RTHP_HEAD}
; Merge the inserted block with its right neighbor when physically adjacent.
RTHP_F_RIGHT
ADD R2,R2,#0
BRz RTHP_F_LEFT
LDR R3,R0,#0
ADD R3,R3,#1
ADD R3,R0,R3
NOT R3,R3
ADD R3,R3,#1
ADD R3,R2,R3
BRnp RTHP_F_LEFT
LDR R3,R2,#0
ADD R3,R3,#1
LDR R2,R2,#1
STR R2,R0,#1
LDR R2,R0,#0
ADD R3,R3,R2
STR R3,R0,#0
; Then merge that combined block into its left neighbor when adjacent.
RTHP_F_LEFT
ADD R1,R1,#0
BRz RTHP_F_DONE
LDR R3,R1,#0
ADD R3,R3,#1
ADD R3,R1,R3
NOT R3,R3
ADD R3,R3,#1
ADD R3,R0,R3
BRnp RTHP_F_DONE
LDR R3,R0,#0
ADD R3,R3,#1
LDR R2,R1,#0
ADD R3,R3,R2
STR R3,R1,#0
LDR R2,R0,#1
STR R2,R1,#1
RTHP_F_DONE
ADD R6,R5,#1
LDR R5,R6,#0
ADD R6,R6,#1
LDR R7,R6,#0
ADD R6,R6,#1
RET`,
    },
  ],
]);

// Fixes the splice order across every program that needs more than one
// section, so two programs calling the same set of runtime functions always
// emit them in the same relative order (deterministic output).
// Appending a new name here never renumbers or reorders
// any existing entry, preserving deterministic output.
export const RUNTIME_ORDER: readonly string[] = [
  'putchar',
  'getchar',
  'printf',
  'scanf',
  'strcmp',
  'strcpy',
  'op-mul',
  'op-divmod',
  'malloc',
  'free',
];

// Every externally visible runtime entry label -- F_putchar through F_free,
// RTMUL, RTDIV, and RTMOD -- maps
// to its frame descriptor, flattened across sections so inspection tools can
// look a callee up by the label a JSR resolves to without knowing which
// section owns it. A callee found here renders as a named frame; one not
// found renders as an anonymous "runtime" frame. Built once at module load;
// the accessor returns the same reference every call, so a store selector
// may return it directly (a fresh map per call would infinite-loop React).
const RUNTIME_FRAMES: ReadonlyMap<string, RuntimeFrameInfo> = (() => {
  const flat = new Map<string, RuntimeFrameInfo>();
  for (const section of RUNTIME_SECTIONS.values()) {
    if (!section.frames) continue;
    for (const [entry, frame] of section.frames) flat.set(entry, frame);
  }
  return flat;
})();

export function runtimeFrames(): ReadonlyMap<string, RuntimeFrameInfo> {
  return RUNTIME_FRAMES;
}
