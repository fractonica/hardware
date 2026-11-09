# qonu: a prompt that says where you are, and the usual listing aliases (SSH, the serial console, the phone terminal).
if [ -n "$PS1" ]; then
	if [ "$(id -u)" = 0 ]; then
		PS1='\[\e[1;31m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]# '
	else
		PS1='\[\e[1;32m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]$ '
	fi
	export PS1
	alias ls='ls --color=auto'
	alias ll='ls -la'
	alias la='ls -A'
fi
