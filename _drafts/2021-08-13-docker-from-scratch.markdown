---
layout: post
title:  "docker from scratch"
date:   2021-08-13 19:05:00 -0300
categories: container
---

I've always used a `FROM _base_image_` on my docker images, and I started wondering how those base images were created. This lead me to a rabbit hole of how containers work and the isolation gained by using them. I'll share my journey in this post!

## Creating a Hello World

Docker already has a guide about base images available [here](https://docs.docker.com/develop/develop-images/baseimages/), so first thing I did was writing a Hello World C program. Just a main function printing "Hello world". I compiled it with the `-static` flag so all dependencies should be included in the binary, that means no dynamic linking. This made the binary go from _17kB_ to _756kB_ on disk, and using `objdump` on the binary compiled without the `-static` flag I can see the following:
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

I have a call to `printf` on my code, so the implementation of `libc` available on my system is linked, and since I am using debian, that is [glibc](https://www.gnu.org/software/libc/). If I compile the same code on [Alpine](https://wiki.alpinelinux.org/wiki/Main_Page), that uses [musl](https://musl.libc.org), my static binary will have _83kB_, close to 10% it was with `glibc`. I've heard before that `musl` was supposed to be lighter (but not complete), so I wanted to do a quick test, but this is a subject that I would like to dive more into some day. The point here is: to build the docker image we need to pack everything, so `-static` is used in this example.

Building and then running the following dockerfile on my debian VM, where the image was build, succeeds!
```Dockerfile
# syntax=docker/dockerfile:1
FROM scratch
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

## Understanding 

From the [Docker website](https://www.docker.com/resources/what-container) "containers virtualize the operating system instead of hardware", so the kernel is shared, and that is why we are able to run a single simple hello world binary on a container. That would be much harder on a VM. Docker provides a layer just above [containerd](https://containerd.io), that is a container runtime. There are some other, kubernetes for example supports [more than just containerd](https://kubernetes.io/docs/setup/production-environment/container-runtimes/). Some other runtimes are [Singularity](https://sylabs.io/singularity/), that has a big presence on the HPC world, there is also [LXC](https://linuxcontainers.org), that I've heard some folks at [r/homelab](https://www.reddit.com/r/homelab/) using, and probably many others.

# standard_init_linux.go

# container_linux.go

## Conclusion
My initial intention was to build a base image with [LFS](http://www.linuxfromscratch.org), but after understanding a little bit more about the way containers are isolated I saw it did not make much sense. Since there is no "boot", we miss the fun part of LFS that is seeing your binaries come to life. Here we would be simply building a very light "toolkit".

I've always heard about how containers isolation was different and lighter than VMs, but trying to create a base image and poking around really helped me learn more! 

https://www.tutorialworks.com/difference-docker-containerd-runc-crio-oci/

cgroups
user namespaces
chroot