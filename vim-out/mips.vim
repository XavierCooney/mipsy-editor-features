if exists("b:current_syntax")
  finish
endif
let s:cpo_save = &cpo
set cpo&vim
syn case ignore


syn match Type "\.text"
syn match Type "\.data"
syn match Type "\.ktext"
syn match Type "\.kdata"
syn match Type "\.ascii"
syn match Type "\.asciiz"
syn match Type "\.byte"
syn match Type "\.half"
syn match Type "\.word"
syn match Type "\.float"
syn match Type "\.double"
syn match Type "\.space"
syn match Type "\.align"
syn match Type "\.globl"
syn match Function "[A-Za-z_][A-Za-z_0-9.]*"
syn match Label "[A-Za-z_][A-Za-z_0-9.]*[ \t]*:"
syn match Comment "#.*$"
syn region asmString start="\"" end="\"" skip="\\\\\|\\\""
syn match Number "\(-\?\)\(\(0x\)\([0-9a-fA-F]\+\)\|\(0b\)\([0-1]\+\)\|\(0o\?\)\([0-7]\+\)\|\([1-9][0-9]*\|0\)\)"
syn match Identifier "\$zero"
syn match Identifier "\$at"
syn match Identifier "\$v0"
syn match Identifier "\$v1"
syn match Identifier "\$a0"
syn match Identifier "\$a1"
syn match Identifier "\$a2"
syn match Identifier "\$a3"
syn match Identifier "\$t0"
syn match Identifier "\$t1"
syn match Identifier "\$t2"
syn match Identifier "\$t3"
syn match Identifier "\$t4"
syn match Identifier "\$t5"
syn match Identifier "\$t6"
syn match Identifier "\$t7"
syn match Identifier "\$s0"
syn match Identifier "\$s1"
syn match Identifier "\$s2"
syn match Identifier "\$s3"
syn match Identifier "\$s4"
syn match Identifier "\$s5"
syn match Identifier "\$s6"
syn match Identifier "\$s7"
syn match Identifier "\$t8"
syn match Identifier "\$t9"
syn match Identifier "\$k0"
syn match Identifier "\$k1"
syn match Identifier "\$gp"
syn match Identifier "\$sp"
syn match Identifier "\$fp"
syn match Identifier "\$ra"
hi def link asmString String


let b:current_syntax = "mips"
let &cpo = s:cpo_save
unlet s:cpo_save
