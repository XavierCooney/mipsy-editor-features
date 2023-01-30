main:
	li	$t0, 0

loop:
	li	$v0, 1
	move	$a0, $t0
	syscall
	addi	$t0, $t0, 1

	la	$a0, some_data
	li	$v0, 4
	syscall

	b	loop

	li	$v0, 0
	jr	$ra

	.data
some_data:
	.asciiz	" hello, world!\n"
