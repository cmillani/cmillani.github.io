---
layout: post
title:  "docker from scratch"
date:   2021-08-13 19:05:00 -0300
categories: container
---

I've always used a `FROM _base_image_` on my docker images, and I started wondering how those base images were created. This lead me to a rabbit hole of how containers work and the isolation gained by using them. I'll share my journey in this post!

## Creating a Hello World

Docker already has a guide about base images available [here](https://docs.docker.com/develop/develop-images/baseimages/), so first thing I did was writing a Hello World C program. Just a main function printing "Hello world". 
```c
#include <stdio.h>

int main() {
	printf("Hello container!\n");
	return 0;
}
```

I compiled it with the `-static` flag so all dependencies should be included in the binary, that means no dynamic linking. This made the binary go from _17kB_ to _756kB_ on disk, and using `objdump` on the binary compiled without the `-static` flag I can see the following:
```bash
$ objdump -T bin/hello 

bin/hello:     file format elf64-x86-64

DYNAMIC SYMBOL TABLE:
0000000000000000  w   D  *UND*	0000000000000000              _ITM_deregisterTMCloneTable
0000000000000000      DF *UND*	0000000000000000  GLIBC_2.2.5 puts
0000000000000000      DF *UND*	0000000000000000  GLIBC_2.2.5 __libc_start_main
0000000000000000  w   D  *UND*	0000000000000000              __gmon_start__
0000000000000000  w   D  *UND*	0000000000000000              _ITM_registerTMCloneTable
0000000000000000  w   DF *UND*	0000000000000000  GLIBC_2.2.5 __cxa_finalize
```

I have a call to `printf` on my code, so the implementation of `libc` available on my system is linked, and since I am using debian, that is [glibc](https://www.gnu.org/software/libc/). If I compile the same code on [Alpine](https://wiki.alpinelinux.org/wiki/Main_Page), that uses [musl](https://musl.libc.org), my static binary will have _83kB_, close to 10% it was with `glibc`. I've heard before that `musl` was supposed to be lighter (but not complete), so I wanted to do a quick test, but this is a subject for another deep dive. The point here is: to build the docker image we need to pack everything, so `-static` is used in this example. 

The [docker hello world image](https://hub.docker.com/_/hello-world) avoid linking `libc` by directly calling the _syscall_:
```c
syscall(SYS_write, STDOUT_FILENO, message, sizeof(message) - 1);
```

Building and then running the following dockerfile on my debian VM, where the image was build, succeeds!
```Dockerfile
# syntax=docker/dockerfile:1
FROM `scratch` 
ADD bin /
CMD ["/hello"]
```

And running `sudo docker images` indicates that the image has the same size of the binary we saw above (756Kb). If we use `docker save` to generate a `tar` for our image and extract this file, we can see our compiled "hello" binary (and also some metadata).

Another way to create this image is simply importing a tar. Using the command from the docker page about base images, we write 
```sh
sudo tar -C bin -c . | docker import - hellotar
```
But this creates an image without the `RUN` keyword, and we need to call it like
```sh
sudo docker run hellotar /hello
```
---

What if we tried to build an image without the `-static` flag?

```
standard_init_linux.go:228: exec user process caused: no such file or directory
```

And more, since the image we just created has only one binary, if we add a command like the following to our Dockerfile:

```Dockerfile
RUN ls
```

We receive this other error:

```
OCI runtime create failed: container_linux.go:380: starting container process caused: exec: "/bin/sh": stat /bin/sh: no such file or directory: unknown
```

Let's look into those functions!

## Digging deeper
First of all, let's understand a little bit better what is going on. We just used docker commands up until now, but while studying the workings of containers I got to understand a little bit more of what happens under the hood when we call `docker run`.

# Docker and Containerd
From the [Docker website](https://www.docker.com/resources/what-container) "containers virtualize the operating system instead of hardware", so the kernel is shared, and that is why we are able to run a single simple hello world binary on a container. That would be much harder on a VM. Docker provides a layer just above [containerd](https://containerd.io), that is a container runtime. There are some other, kubernetes for example supports [this list](https://kubernetes.io/docs/setup/production-environment/container-runtimes/).

# Containerd and runc
Containerd uses runc, that implements the [OCI specification](https://opencontainers.org), to actually run each container. The files we received as error when trying to run without linking or running something not present are defined in this repository, [container_linux.go here](https://github.com/opencontainers/runc/blob/master/libcontainer/container_linux.go) and [standard_init_linux.go here](https://github.com/opencontainers/runc/blob/master/libcontainer/standard_init_linux.go).

# The code that triggered the errors above.

On __standard_init_linux.go__ we see the following code:
```go
if err := system.Exec(name, l.config.Args[0:], os.Environ()); err != nil {
    return newSystemErrorWithCause(err, "exec user process")
}
```
Here, system is a package inside `runc`, and the `Exec` function is defined [here](https://github.com/opencontainers/runc/blob/v1.0.1/libcontainer/system/linux.go#L41). Diving to this function, it calls `unix.Exec`, where `unix` is from the `sys/unix` go package, and the exec method simply replaces the current process with the target one. Since we received this error when trying to execute a dynamically linked binary where the needed libraries were not present, it fails with a 127 return, that means that "command not found". Since the dynamic library is not present, it makes sense.

On __container_linux.go__ the code present is this:

```go
if err := parent.start(); err != nil {
    return newSystemErrorWithCause(err, "starting container process")
}
```
Here, `parent` is created from `c.newParentProcess`, where `c` is a pointer to a struct `linuxContainer` defined in the same file, and `newParentProcess` creates an `initProcess`. The method `start` inside `initProcess` is defined [here](https://github.com/opencontainers/runc/blob/v1.0.1/libcontainer/process_linux.go#L329), and it basically call `exec.Cmd.Start` [from the os/exec go library](https://pkg.go.dev/os/exec#Cmd.Start).

# Understanding the role of both functions
Both methods drill down to a similar problem, that is some kind of `exec` being called where it is not valid. I suspected that the difference was simply due to the commands: in one place we used `CMD` in the dockerfile, and `RUN` in the other, but if I replace `CMD [/hello]` with `CMD [ls]`, I still receive an error on file __container_linux.go__:
```
docker: Error response from daemon: OCI runtime create failed: container_linux.go:380: starting container process caused: exec: "ls": executable file not found in $PATH: unknown.
ERRO[0000] error waiting for container: context canceled
```
which makes sense, since there is no `ls` binary to be found, but that makes me wonder which roles does __container_linux__ and __standard_init_linux__ plays. 

Following references from __standard_init_linux__ leads us to the definition of the `initCommand`, that is exposed to the `runc` CLI with the following documentation:
```
init        initialize the namespaces and launch the process (do not call it outside of runc)
```

Calling `runc init` on bash has no effect because, as the docs says, we need to call inside a `runc` context, and we can see on `init.go` that it expects a `_LIBCONTAINER_LOGLEVEL` environment variable to be defined. This is where things starts to connect, searching where this variable is defined lead me to `container_linux.go`, [at method `commandTemplate`](https://github.com/opencontainers/runc/blob/v1.0.1/libcontainer/container_linux.go#L528). This a a method from the same `linuxContainer` struct, and it is called on `newParentProcess`. 

Calls to `start` method on `container_linux` can come from some CLI calls:
```
create      create a container
exec        execute new process inside the container
restore     restore a container from a previous checkpoint
run         create and run a container
```

Ok, so `standard_init_linux` is called after `container_linux`, but what are the roles they play here? From our experiments, we received an error on `standard_init_linux` when the binary was not present, and on `container_linux` for cases where it was not even possible to start our binary. 

We will continue studying `runc`, but before, to give a little more understanding about the errors we just faced, it seems that when we write `RUN ls` on `dockerfile` the engine tries to start a `sh` process inside the container to run our command, but since there is no `sh` there, it fails. When we try to start the binary without the needed dynamic library it is able to start, but fails soon. The same happens when we try to `CMD ['ls']`: there is no such binary in our container, so it does not even starts executing.

Let's study a lit bit more about `runc`.

# Diving into runc

Following with some changes the [section at runc's README](https://github.com/opencontainers/runc/tree/v1.0.1#creating-an-oci-bundle) about running a container, we could:

```sh
# hello is the name of the container we just built, this creates a container and exports its filesystem
docker export $(docker create hello) | tar -C rootfs -xvf - 
# creates a default runc config.json, that instructs how to launch the container
runc spec
# default process is sh, but there is no sh in our hello container, so set it to our binary
jq '.process.args[0] = "/hello"' config.json | sponge config.json 
# to call runc start (that creates the container but does not run the binary) we need to provide a tty
# recvtty implements a tty needed to use the create command, and should be built from runc with "make rcvtty"
/path/to/recvtty hello.sock & # we send it to background, you could run it in other terminal to see the output of out code!
# creates the conteiner
sudo runc create --console-socket hello.sock rawhello
# Should list "runc init"
ps aux | grep runc 
sudo runc start rawhello # Should output to recvtty - try it on other terminal! :)
sudo runc delete rawhello # Clean up
```

We should see something like this:
```
carlos    6070  0.0  0.3 1078640 9052 pts/1    Tl   19:05   0:00 /home/carlos/projects/dfs/runc/contrib/cmd/recvtty/recvtty hello.sock
root      6086  0.0  0.5 1159560 17300 pts/0   Ssl+ 19:05   0:00 runc init
carlos    6143  0.0  0.0   6076   884 pts/1    R+   19:05   0:00 grep runc
```
and the output of "hello" image printed on the terminal running `recvtty`.

There is out `runc init`! What happens is, the isolation of a container is obtained by using a list of kernel features, such as namespaces, cgroups and LSMs, and you can read more about that [here](https://www.capitalone.com/tech/cloud/container-runtime/). This achieves our isolation, and the way `runc` works, it creates the isolated container and starts a process `runc init` inside it, that is replaced by our command when we execute `runc start`. `init` act as a placeholder while start is not called.

![runc execution flow](/assets/docker-from-scratch/runc_init.jpg)
Image from [unit42.paloaltonetworks.com](https://unit42.paloaltonetworks.com/breaking-docker-via-runc-explaining-cve-2019-5736)
The post linked above helped me understand better the inner workings of runc.

There are a lot of interesting things going on here, the `config.json` generated by `runc spec` has a lot of information! I want to study more about that later :)

## The whole model
Taking what we just discussed in the last topic, the whole process from `docker run` to the actual container running would be something like this:

![docker execution flow](/assets/docker-from-scratch/docker_flow_simple.png)

But it is a bit more complicated than that, and we will see it by running `strace`, a tracing tool that lets us see syscalls made by a program. In order to capture the whole execution flow, we will need three terminals:

__Terminal #1__

```sudo strace -ff -o containerd.txt -p $(pgrep containerd)```

__Terminal #2__

```sudo strace -s 80 -ff -o dockerd.txt -p $(pgrep dockerd)```

__Terminal #3__

```sudo strace -ff -o docker.txt docker run hello```

# Docker to dockerd

This will generate a list of files, one for each thread spawned by each of those processes, and we can inspect those files to see what the threads were up to.

```
$ grep connect docker.txt* 

...
docker.txt.13457:connect(7, {sa_family=AF_UNIX, sun_path="/var/run/docker.sock"}, 23) = 0

```

Here we can see docker communicating with [dockerd through a unix domain socket](https://docs.docker.com/engine/reference/commandline/dockerd/#daemon-socket-option).
(Note: each output will be different, the getaway here is that those threads are opening `docker.sock` to communicate with `dockerd`)


# Dockerd to containerd

Next, we can check `dockerd` talking to `containerd`. This one is trickier since the connection to `conteinerd.sock` is not open on demand like we saw above on `docker.sock`. We can in fact check that there is a connection from `dockerd` to `containerd.sock` by running:

```sh
# This lists files opened by containerd and specifies that we want endpoint information on UNIX sockets
$ sudo lsof +E -aUc containerd 

...
container 15851 root   10u  unix 0x000000004fe13ce6      0t0 8035230 /run/containerd/containerd.sock type=STREAM ->INO=8035882 15861,dockerd,10u
container 15851 root   11u  unix 0x000000004979028a      0t0 8035883 /run/containerd/containerd.sock type=STREAM ->INO=8044007 15861,dockerd,11u
dockerd   15861 root   10u  unix 0x00000000f58b2dcb      0t0 8035882 type=STREAM ->INO=8035230 15851,container,10u
dockerd   15861 root   11u  unix 0x00000000872ba96d      0t0 8044007 type=STREAM ->INO=8035883 15851,container,11u
```

With the number of the file descriptor (10 and 11, listed as 10u and 11u above) we can look for calls to write on the generated txts, using `grep 'write(10' dockerd.txt\*`, and we will find thinks like this:

```
dockerd.txt.15864:write(10, "\0\0\10\6\1\0\0\0\0\2\4\20\20\t\16\7\7\0\0\4\10\0\0\0\0\0\0\0$\345\0\0\10\6\0\0\0\0\0\2\4\20\20\t\16\7\7", 47) = 47
dockerd.txt.15864:write(10, "\0\0\10\1\4\0\0\0\211\203\206\315\323\322\321\320\317\0\0G\0\1\0\0\0\211\0\0\0\0B\n@056f171aa8aaf7e32871c732f3bb98f44047ec34bb69744"..., 97) = 97
```

If we search the string `056f171aa8aaf7e32871c732f3bb98f44047ec34bb69744` present above in the `syscalls` log generated by `strace` we can find it appears many times on the path `/var/lib/docker/containers/056f171aa8aaf7e32`, and if we run `sudo docker ps -a --filter "id=056f171aa8aaf7e32871c732f3bb98f44047ec34bb69744"` we can find our hello container with this ID there:

```
CONTAINER ID   IMAGE     COMMAND     CREATED       STATUS                   PORTS     NAMES
056f171aa8aa   hello     "./hello"   2 hours ago   Exited (0) 2 hours ago             loving_mccarthy
```

The meaning of the text we saw on the `write` calls is out of scope here, I imagine that on those first calls to write `dockerd` is instructing `containerd` to create a container with the given `ID`, but we should check that on the docs.

# Containerd to runc

The last step is: how is `containerd` talking to runc? This step is a bit easier and shows us what we already saw with `runc init`. Searching for `execve` on the txts generated by our trace on `containerd` gives us what we need:
(just some lines of the output are shown)

```sh
$ grep execve containerd.txt*

containerd.txt.17327:execve("/usr/bin/runc", ["runc", "--root", "/var/run/docker/runtime-runc/mob"..., "--log", "/run/containerd/io.containerd.ru"..., "--log-format", "json", "create", "--bundle", "/run/containerd/io.containerd.ru"..., "--pid-file", "/run/containerd/io.containerd.ru"..., "2f879386efacc25f502353dbbf6e5d60"...], 0xc000236180 /* 7 vars */) = 0
containerd.txt.17335:execve("/proc/self/exe", ["runc", "init"], 0xc000096140 /* 7 vars */) = 0
containerd.txt.17337:execve("./hello", ["./hello"], 0xc0001c3a40 /* 3 vars */
```

Here we can see `containerd` starting `runc`, then starting `runc init` and finally our `hello` is executed.


In the end, there is one more step to out flow above:
![docker execution flow complete](/assets/docker-from-scratch/docker_flow_complete.png)

## So why are the errors different?

Now, lets use all this tooling that we got to know to test two more cases. We were able to create and run a container using `runc`, now let's change the `config.js` from the successful export we did to run something else, and then, let's also export a version of the image with dynamic link to `libc`.

# Running non present binary
Running and tracing gives us the following output, as expected:
```sh
$ sudo strace -s 120 -ff -o runc.txt runc run hellols
ERRO[0000] container_linux.go:380: starting container process caused: exec: "ls": executable file not found in $PATH 
```

So `container_linux` appears again, now lets look into the trace. As we can see below, on one thread init is called with success, but on other we see that it was not possible to locate the executable `ls`.

```
runc.txt.18743:execve("/proc/self/exe", ["runc", "init"], 0xc0002ae000 /* 8 vars */) = 0
runc.txt.18738:write(9, "{\"type\":\"procRun\"}", 18)  = 18
runc.txt.18738:read(9, "{\"type\":\"procError\"}", 512) = 20
runc.txt.18738:read(9, "{\"Timestamp\":\"2021-08-15T19:13:07.442446078Z\",\"ECode\":10,\"Cause\":\"\",\"Message\":\"exec: \\\"ls\\\": executable file not found i"..., 512) = 512
```

Ok, what is this file descriptor 9?

Running strace again with `-yy` to bring more information about file descriptor.
```sh
$ sudo strace -yy -s 120 -ff -o runc_fd.txt runc run hellols2
```
With this we get some more details about `fd` number 9:
```
runc_fd.txt.18928:write(9<UNIX:[8126329->8126328]>, "{\"type\":\"procRun\"}", 18) = 18
runc_fd.txt.18928:read(9<UNIX:[8126329->8126328]>, "{\"type\":\"procError\"}", 512) = 20
runc_fd.txt.18928:read(9<UNIX:[8126329->8126328]>, "{\"Timestamp\":\"2021-08-15T19:42:17.814404294Z\",\"ECode\":10,\"Cause\":\"\",\"Message\":\"exec: \\\"ls\\\": executable file not found i"..., 512) = 512
```

Ok, what are those numbers in `<UNIX:[8126329->8126328]>`? After some digging, looking for `socket` into the logs I found something:

```
runc_fd.txt.19077:socketpair(AF_UNIX, SOCK_STREAM|SOCK_CLOEXEC, 0, [8<UNIX:[8253085->8253086]>, 9<UNIX:[8253086->8253085]>]) = 0
```

At this point I believe what happens is that `runc init` communicates with the original `runc` process using this socket and tells about the error when trying to locate the binary to start the designated process.

Looking for `procError` inside the code, we can find it inside method `StartInitialization` on `factory_linux.go`, before `Init` from `standard_init_linux.go` being called:
```go
defer func() {
    // We have an error during the initialization of the container's init,
    // send it back to the parent process in the form of an initError.
    if werr := utils.WriteJSON(pipe, syncT{procError}); werr != nil {
        fmt.Fprintln(os.Stderr, err)
        return
    }
    if werr := utils.WriteJSON(pipe, newSystemError(err)); werr != nil {
        fmt.Fprintln(os.Stderr, err)
        return
    }
}()
```

And to answer my last question as to why the defer is always sending an error, we have a nice documented line below:

```go
// If Init succeeds, syscall.Exec will not return, hence none of the defers will be called.
return i.Init()
```

So, when we are able to initialize successfully out container, we replace the original process, and that defer is not called. But from the trace files, there was no call to `execve` telling it to start `ls`, so it must have failed before line 228.

And, there it is:
```go
// Check for the arg before waiting to make sure it exists and it is
// returned as a create time error.
name, err := exec.LookPath(l.config.Args[0])
if err != nil {
    return err
}
```

`Runc` outsmarts me by looking for my binary before actually trying to execute it, that is why the last `execve` is not called, and that is why the line reported is different.
That was a long run to understand why both commands gave different errors, and the reason behind is pretty reasonable, the runtime check before trying to start a binary that does not exist, and fails early.


## Conclusion
My initial intention was to build a base image with [LFS](http://www.linuxfromscratch.org), but after understanding a little bit more about the way containers are isolated I saw it did not make much sense. Since there is no "boot", we miss the fun part of LFS that is seeing your kernel come to life. Here we would be simply building a very light "toolkit", and without a package manager. 

I've always heard about how containers isolation was different and lighter than VMs, but trying to create a base image and poking around really helped me learn more! 

I'm curious now about how namespaces, selinux and cgroups works, I'll investigate and post some more poking around linux here soon!