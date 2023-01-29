main:
	la	$a0, some_data
	li	$v0, 4
	syscall

	li	$v0, 0
	jr	$ra

	.data
some_data:
	.asciiz	"Hello, world!"
