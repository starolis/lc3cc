F_twice
ADD R6,R6,#-1
ADD R6,R6,#-1
STR R7,R6,#0
ADD R6,R6,#-1
STR R5,R6,#0
ADD R5,R6,#-1
ADD R6,R6,#-1
; C line 1: int twice(int value) { return value + value; }
LDR R0,R5,#4
STR R0,R5,#0
LDR R0,R5,#4
LDR R1,R5,#0
ADD R0,R1,R0
STR R0,R5,#3
BR L_twice_epilogue
L_twice_epilogue
ADD R6,R5,#1
LDR R5,R6,#0
ADD R6,R6,#1
LDR R7,R6,#0
ADD R6,R6,#1
RET
