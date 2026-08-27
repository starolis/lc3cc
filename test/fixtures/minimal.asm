.ORIG x3000
; crt0 (generated): initializes R4/R6 for the calling convention, calls main, halts on return.
LD R4,CRT0_GLOBAL
; R6 = xF000, not xEFFF: R6 always points AT the top OCCUPIED stack word (never one
; past it), and every push decrements before storing (ADD R6,R6,#-1 then STR) -- so
; the first word ever pushed lands at xEFFF, matching the book stack-base drawings.
LD R6,CRT0_STACK
JSR F_main
ADD R6,R6,#1
HALT
CRT0_GLOBAL .FILL GLOBAL
CRT0_STACK .FILL xF000
F_main
ADD R6,R6,#-1
ADD R6,R6,#-1
STR R7,R6,#0
ADD R6,R6,#-1
STR R5,R6,#0
ADD R5,R6,#-1
; no locals or temporaries to reserve
; C line 1: int main(void) { return 0; }
AND R0,R0,#0
STR R0,R5,#3
BR L_main_epilogue
L_main_epilogue
ADD R6,R5,#1
LDR R5,R6,#0
ADD R6,R6,#1
LDR R7,R6,#0
ADD R6,R6,#1
RET
GLOBAL
.FILL #0 ; placeholder -- program declares no globals
.END
