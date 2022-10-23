---
layout: post
title:  "rxjupyter: reactive multiprocess programming on python"
date:   2022-04-14 19:05:00 -0300
categories: python, jupyter, rx
---

One of the projects I work on currently uses [Jupyter Lab](https://jupyter.org/) as an UI. It is really mature, solved our problems with little cons, the match was perfect for out MVP!

Using [ipywidgets](https://ipywidgets.readthedocs.io/en/stable/) we built some user interfaces: the user executes a notebook that simply imports a controller and calls "show", or something like that. This "show" method sets up all widgets and the user now has an interface to interact with. We arrived at one point where there are many "view notebooks" and some of that changes state that should be reflected on others, that is when the crazy scientist inside me awakened! Let't make reactive programming across different processes!

I'll avoid bothering anybody that is here for solution with storytelling, so if you want [the real deal, jump here](#the-real-deal).

# Investigate!

Well, as I was well thought at the [Apple Developer Academy](https://developeracademy.eldorado.org.br/campinas/), here I am, [basing my learning on challenges](https://digitalpromise.org/initiative/cbl/). I am already engaged, I have a personaly relevant challenge to solve! But how?

I love diving deep into systems ([really?]({% post_url 2021-08-21-docker-from-scratch %})), and I saw this as an opportunity to study more about Inter Process Communication (IPC). I could solve this problem by running a broker on the same host or even using a remote one, but where is the fun in that!? Besides that, resource-wise it does not seem very interesting, as the only thing I want is to transmit some events (without data) across some jupyter notebooks (few data, few clients).

## The first directions

Everything is a file on Linux, right? Well IPC too can be files. I started reading about named pipes, sockets, message queues, FIFO files, and saw many more resources to allow two processes to communicate. 

I started tinkering with some of those concepts and, allied to file locks I was able to start a prototype, but things were clunky (as in my experience so far is concurrency in python - hope to change that as I learn more). Turns out there is already a solution for problems like mine: [dbus](https://www.freedesktop.org/wiki/Software/dbus/). Taking a look at tutorial, the [signal part](https://dbus.freedesktop.org/doc/dbus-tutorial.html#signalprocedure) got me, so I decided that this was a better way to try to create a beta version (and [this SO post](https://stackoverflow.com/questions/42239568/broadcast-ipc-on-linux) helped me make this decision). Here we go!

# Act

## DBus here I go

First off, how do I start and connect to a DBus? I know I need a daemon, so let's start by installing DBus on my machine and reading some docs. With dbus installed locally I run:
```sh
dbus-run-session /bin/bash
```

This command starts the given program (bash) inside a dbus session. I can `echo $DBUS_SESSION_BUS_ADDRESS` and a temporary file will be created. This aparently is the socket where the DBus daemon receives all communications. Let't try a simple program.

First, I open a new shell and setup DBus monitor:
```sh
export DBUS_SESSION_BUS_ADDRESS=<VALUE_FROM_OTHER_SHELL> # make sure both shells are using same dbus
dbus-monitor
```
I can see some messages already, but I'll run the following python example to better feel things (example modified from [here](https://github.com/freedesktop/dbus-python/blob/master/examples/example-signal-emitter.py)):
(more details installing `dbus` bellow)
```py
import dbus
import dbus.service
from gi.repository import GLib
import dbus.mainloop.glib

class TestObject(dbus.service.Object):
    def __init__(self, conn, object_path='/br/com/cadumillani/TestService/object'):
        dbus.service.Object.__init__(self, conn, object_path)

    @dbus.service.signal('br.com.cadumillani.TestService')
    def HelloSignal(self, message):
        pass

dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)

session_bus = dbus.SessionBus()
name = dbus.service.BusName('br.com.cadumillani.TestService', session_bus)
object = TestObject(session_bus)
object.HelloSignal("Message")
loop = GLib.MainLoop()
loop.run()
```

Running the code above I could see many lines from the `dbus-monitor` running, one of them was:
```sh
signal time=1666551890.153705 sender=:1.9 -> destination=(null destination) serial=3 path=/br/com/cadumillani/TestService/object; interface=br.com.cadumillani.TestService; member=HelloSignal
   string "Message"
```

I'll not disect the above message, but we can see some parameters that we configured (such as path, interface and member), a `null` destination makes sense for a broadcast 

To install dbus-python I needed to install some dependencies: build-essential, pkg-config, cmake, libdbus-1-dev, libgtk2.0-dev, python3-dev. To make the example work I had to also install libgirepository1.0-dev in order to use GLib's python module. All those system dependencies made it possible to run `pip install dbus-python pygobject` (used to import dbus and gi, respectively). Phew. 

Now, I'm not confortable bundling all that on a Jupyter docker image, and althought I'm sure there may be a way to generate a pre-built version of this library, I'm not sure it will be much easier.

## Another DBus try

The [page about python bindings for dbus](https://dbus.freedesktop.org/doc/dbus-python/) itself alerts:
> dbus-python might not be the best D-Bus binding for you to use

Who am I to disagree? [This page](https://wiki.python.org/moin/DbusExamples) provides some options, and [pydbus](https://github.com/LEW21/pydbus) and [dasbus](https://github.com/rhinstaller/dasbus) seemed like good options by the description. It seems line pydbus is [not maintained](https://github.com/LEW21/pydbus/issues/93) anymore, and `dasbus` requires `PyGObject`, which I'm avoiding since there is no use for those libraries on our current docker image.

I tested `pydbus` and it seemed great, the only issue was that it was filtering signals based on the service name, which should not happen. Maybe it was a misconfiguration, or really a bug, but DBus seems to be really focused on the desktop environment, and that is not what I'm aiming for. Back to the whiteboard.

# Investigate again!

## Files it is

So instead of trying to hammer screws down using DBus without a desktop I'll keep digging at using Linux's IPC in a more bare metal fashion. I'll explain a little bit about my ideas about each alternative I found. Well, to be honest with the section title, there is also shared memory and signals to be discussed, so not only files. I'll briefly overview the possibilities with each of the options available, then choose one from them all to start testing. I'm using [this documentation](https://tldp.org/LDP/tlk/ipc/ipc.html) as base.

### Files in general
I see four main options here:
* **Sockets**: TCP like communication, a little bit more complex, but there is an [easy native library](https://docs.python.org/3/library/socket.html);
* **Message Queues**: Never worked with, but seems interesting. Need to check it there is some native library and notification mechanism;
* **Named Pipes**: Seems easier than sockets, but I expect fewer high level methods on python;
* **Plain files**: Nope, too much hard work when there are simpler options;

Named pipes and plain files are ruled out since there are higher level alternatives with better APIs. Looking into message queues I found a [message on the mail list from 2001](https://mail.python.org/pipermail/python-list/2001-May/109644.html) and one [package](https://pypi.org/project/ipcqueue/). Socket is looking like the best option here, but I will need to manually handle [accepting](https://docs.python.org/3/library/socket.html#socket.socket.accept) connections and [connecting](https://docs.python.org/3/library/socket.html#socket.socket.connect) when I want to send data.

### Shared Memory
Python has a [native module](https://docs.python.org/3/library/multiprocessing.shared_memory.html), but from the shallow dive I did there is no notification mechanism, although Python seems to handle concurrency. Another mechanism to notify will be needed.

### Signals

We could use some [user defined signal](https://docs.python.org/3/library/signal.html#signal.SIGUSR1). The [only way I found](https://stackoverflow.com/a/20972299/5771078) to send signals using python is a little bit weird, but ok.

# One more act: technicalities solved, architecture time

We need to **discover** and **notify** (with little **associated data**). To **discover** we can either look for running processes or files on a shared folder, and I'll discuss more about it later. **Notifying** and **sending data** is a little bit harder. From what I learned the best option seemed like message queues associated with signals, but since there is no native Python library for that (and if I were to write it from scratch I might as well do it for DBus) shared memory seems like the best option (also assiciated with signals).

So, how will I form this network? A ring? All to all? A coordinator? 
Well, I expect from 10 to 20 processes running in this scheme, so nothing huge. To connect every peer with the others I'll need (20/2 - 1) * 20 + 10 = 190 connections (hope I'm still able to do math). Compared with the complexity of the other schemes, this is my choice. 

Going back to **discoverying**. I went from doing something like `ps` to look running processes, back to using a file so every interested node can write its PID, back to using only `ps` with an additional handshake, then I finally thought of leveraging shared memory to my side: besides one shared address between every two peers, I'll have a shared array with every peer, this way they can put PIDs there, and the network can be formed from this information.

# The real deal
