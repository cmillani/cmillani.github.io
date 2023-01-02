---
layout: post
title:  "don't code, don't host: an as a service story"
date:   2022-10-23 00:00:00 -0300
categories: service, cloud, SaaS, PaaS
---

If the best code is [no code](https://github.com/kelseyhightower/nocode), the best host is no host.

I've recently started studying OS optimizations such as Unikernels and Lightweight kernels for my master's degree and it changed a little bit the way I see the benefits of PaaS/SaaS/*aaS products.

In this text I'll briefly talk about the most common benefits of using someone else's code and infra, and then I'll dive into what I've learned during my research.

# Easiness and maintenance

Products offered as a service come with easiness of setup and maintenance: I usually don't need to care much about OS updates, software updates and tuning. Besides that, (I hope that) specialists are present to help troubleshoot and configure the systems.

Those are the selling points I used to hear, and they alone already sold the services to me. There is so much work and knowledge in keeping everything updated (and thus safer) and configuring to obtain maximum performance, that doing everything in-house would probably be more expensive and yet not achieve the same results.

# The next step in performance

I started my research with [this article from Barroso](https://dl.acm.org/doi/10.1145/3015146)(recommend it!), and it blew my mind the percentage of resources spent on IO alone in a data center. Later I found [Demikernel](https://github.com/demikernel/demikernel) and other research kernels, and how they were able to achieve improvements in applications such as Redis, Memcached, and Nginx from 200% to 900% in throughput (see [Arrakis](https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-peter_simon.pdf)).

All that was achieved by using techniques such as **kernel bypass**, which is communicating directly with the hardware without the kernel in the middle, and **single user space**, which completely removes the concept of kernel and user spaces and makes everything one big memory space. This segregation of user and kernel memories and also making hardware communications go through the kernel is essential when there are multiple processes or even users running in the same OS and there are security policies that need to be enforced, but, in the Cloud context, we are moving to scenarios where we only care about one single program per instance. The kernel then starts acting as unnecessary overhead, forcing us to use APIs that may limit IO (as discussed by Barroso) and make a series of validations and copies of data.

My master's is in systems and the team I'm part of works with High-Performance Computing and Data Science, so Redis and Nginx, two common services I saw in **Unikernels and LibOSes** papers, are not present. I continued my bibliography review into **OSNoise**, and that is when I found **Lightweight kernels**. When you execute a binary on your computer your CPU is not exclusive to it. There are background processes (daemons) and kernel threads that are necessary to keep everything running on a common OS, and there are many cases where one CPU core must stop doing whatever it was doing to handle other chores, such as incoming network data. It is like being the chef and server at the same time: the pan is hot and the pasta is boiling, but the moment a new customer arrives you need to turn it off, change clothes, and go get the order. Lightweight kernels provide a virtualized environment where the minimum is running, so your process has the most CPU time possible.

In HPC clusters the OS is tuned to minimize the OSNoise, removing unnecessary processes (from user and kernel spaces), and ethernet is usually replaced by Infiniband, which takes advantage of kernel bypass. Besides that, I still found studies that running a lightweight kernel may provide a 200% boost in performance, measured by computation time. [This paper](https://ieeexplore.ieee.org/document/6012894) provides more information on what is OSNoise, and [this one](https://dl.acm.org/doi/abs/10.1145/3458817.3476162) provides an implementation of a lightweight kernel. 

# Everything in its place

Outside my master's I work as a Software Architect, and that brings us back to *aaS products and the first sentences of the text. In my job I'm closer to the user than to the system, the code me and my team work on needs to solve specific business problems. Operating systems, web servers, and databases are tools to us, not the focus of our job. When I host a broker, a DB, or many other things I'm diverting from my main goal of solving users' problems to learn how to properly set up and maintain those applications, and I'll probably make it worse than if I bought them as a service. 

I spent some weeks searching for optimizations related to the field I'm studying, and learned many things but have yet to find something that has a bigger chance of improving performance in the scenario I'm working on. All those improvements I learned focus on IO or CPU intensive applications and my team is working with GPU intensive workloads. When I found an approach I'm comfortable with I will still have to study and test implementing it in my context, which will have another learning curve. My role as a master's candidate is to do research, and I'm comfortable with the time I'm spending without tangible results, but the situation changes completely on my job: spending months to improve Redis (for example) performance would probably not be the best choice when I could buy a service and focus on the product instead.

When you are implementing a web service you don't implement your own database engine from scratch, you use one that is available and ready, right? So why should you build your database server from scratch? Buy it as a service and solve your customer's problems fast! Once you reach a point where you need to or it is economically better to run it on-premise, you will probably be facing a good problem, [like dropbox did in 2016](https://news.ycombinator.com/item?id=11282948).

> Note: this post was edited on December 31 (2022) to add some clarity - feel free to look at the [history](https://www.wired.com/2016/03/epic-story-dropboxs-exodus-amazon-cloud-empire/)


