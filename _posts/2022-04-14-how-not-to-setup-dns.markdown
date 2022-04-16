---
layout: post
title:  "how not to setup a DNS server - a tale of a broken cluster"
date:   2022-04-14 19:05:00 -0300
categories: dns, infrastructure, externaldns, kubernetes
---

> TL;DR: My cluster broke, needed to nuke it, and took the opportunity to automate the creation of a simple cluster using IaC, code available [here](https://github.com/cmillani/homelab_iac/tree/023cb1b88eaf42ab66644181250cb80ad2af2709)

This is a "little disaster" recovery short post, a tale of how not to setup a DNS server, and how to use a bad situation as a motivation to automate infrastructure.

A while ago I setup [externaldns with coredns]({% post_url 2021-09-25-external-dns %}), configured my DHCP server to use CoreDNS as one of its DNS servers, and it was really nice being able to create a new ingress and just type the address in my browser - it just worked! 

Since my DHCP server is setting CoreDNS as a name server for the whole network if it fails for some reason things would get messy. Since I turn my cluster off sometimes (I have no remove access, so when I travel there is no reason to keep it on) things did get messy. 

I came back from vacation, did some basic maintenance on the servers, and when I started the cluster it did not come up.

## My mistakes

Well besides setting up my DNS Server in a way that it was not cool to restart, when I came back from vacation I decided to take some time to update my servers. I use Debian as my host, and one of the hosts, and all Kubernetes VMs (3 VMs) were on Debian 10. Debian 11 has been around since October 2021, let's update this. Also, I was on Kubernetes 1.21, EOL is coming in June 2022, let's update this as well. Instructions to upgrade a Kubeadm cluster seem to only cover HA (High Availability) clusters, instructing to drain one control plane node at a time. Ha, the joke is on you, I only have one control plane node!

So I turn on the hosts, carefully upgrade Debian, turn on the nodes VMs, start the Kubeadm upgrade, and notice that something like

```sh
Unable to register node "node-name" with API server
```

is on my kubelet logs, and nothing works.

> This is one of the burdens of having a homelab that I'm still not used to upgrading every service and the OS

## I'll Pollyanna my way to a better infra

I had my first contact with IaC [setting up homeassistant]({% post_url 2022-02-12-terraforming-home-assistant %}) similarly: it failed, I took the opportunity to automate the creation of the service. Now, with better know-how and another failing service, I expanded my script to take care of my cluster as well.

For sure I'm not the first one to automate the creation of a Kubeadm cluster, but there are some details on my setup that made me make my own scripts:
* I don't ~~want~~ have enough hardware for a HA cluster
* I'm using KVM, and the only module I found was really outdated

The scripts I wrote are nothing near some production options I saw that connected with public cloud providers, but I'll reach that someday. The final code is available [here](https://github.com/cmillani/homelab_iac/tree/023cb1b88eaf42ab66644181250cb80ad2af2709) (fixed commit to avoid drift). At the `k8scluster` folder there are some `terraform` and `ansible` files. By running terraform it will create 1 control plane and 2 worker nodes, and install all dependencies using ansible scripts. I took this opportunity to better study and organize all terraform files, and now there is some hierarchy and reuse of modules, but there are still some things I'm not happy about:

* There is no way to pass a provider as a parameter in terraform ([see this](https://github.com/hashicorp/terraform/issues/24476))
* I may lack practice or a need to change my way of thinking, but the way `terraform` and its `tfstate` works seems a little bit limiting:
  * Exiting resources are not taken into consideration: I tried creating a module to setup base images, but using this module inside two different root modules (one for HomeAssistant, other for the cluster) ended up trying to create the base images twice. In the end, I created one single root module for my whole infra
  * In my case the single root module worked, but I'm intrigued by how am I supposed to handle enormous infrastructures this way: If a want to create a subscription for multiple projects, do every project need to be inside the same terraform hierarchy? Or do I need to manually know the order to run the scripts?

## Next Steps

I'm not happy with my current IaC setup, I wish I could better isolate applications. I've heard some good things about [Terragrunt](https://terragrunt.gruntwork.io/), I hope I'll be able to take a look at it before another service fails :D

In the end, I saved some time going from 1.21 directly to 1.23. I just need to automate installing the apps on the cluster, it took me some time to recover everything after having a brand new cluster.

I'm taking a look into other ways of having `externaldns` on-prem. I could install CoreDNS outside the cluster but I'm not happy with needing an `etcd` server, so I'm looking into PowerDNS.