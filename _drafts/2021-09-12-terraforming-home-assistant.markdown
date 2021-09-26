---
layout: post
title:  "provisioning home assistant with terraform and ansible"
date:   2021-09-12 19:05:00 -0300
categories: infra
---

Earlier this month my [home assistant](https://www.home-assistant.io) installation broke. During an auto-update something went wrong and the system was then in a state where I could not bring that back. I am using Home Assistant Supervised on a Debian VM, and there are [some warnings](https://www.home-assistant.io/installation/linux#install-home-assistant-supervised) about this king of setup.

Well, after some attempts to bring the service back to life, I decided to take this as an opportunity to learn a little bit of some automation tools. On the next session I'll describe which tools and why, and next the steps I used to provision my instance of Home Assistant.


## The right tool for the right job

At first I intended on using [Terraform](https://www.terraform.io) to create the VMs and install Home Assistant, but after reading a little about this tool it seemed like that was not a good idea. The installation part was not connecting very well with what I just read. That is where [Ansible](https://www.ansible.com) comes to play.

Both tools are used for automation, and although there are some comparisons between them and even ways to do the same thing on both (I found tutorials on creating a K8s cluster using both), for my use case I decided to create the VM using Terraform (setting VM specs, attached network interfaces, etc) and setup Home Assistant using Ansible (install dependencies, the software itself and restore my backup).

## Provisioning the VMs with Terraform

There is no official libvirt Provider for Terraform at the time of this writing, but there is a community one! Using [this provider](https://registry.terraform.io/providers/dmacvicar/libvirt/latest/docs) I was able to give my first steps. With very little effort I was able to spin a Debian VM. Following [this example](https://github.com/dmacvicar/terraform-provider-libvirt/blob/main/examples/v0.13/ubuntu/ubuntu-example.tf), I got this `tf` file:

```tf
terraform {
  required_providers {
    libvirt = {
      source = "dmacvicar/libvirt"
    }
  }
}

provider "libvirt" {
  uri = "qemu+ssh://carlos@192.168.1.5/system"
}

resource "libvirt_pool" "home_assistant" {
  name = "home_assistant"
  type = "dir"
  path = "/home/carlos/volumes"
}

resource "libvirt_volume" "home_assistant-qcow2" {
  name   = "homeassistant-qcow2"
  pool   = libvirt_pool.home_assistant.name
  source = "http://cloud.debian.org/images/cloud/bullseye/latest/debian-11-genericcloud-amd64.qcow2"
  format = "qcow2"
}

data "template_file" "user_data" {
  template = file("${path.module}/cloud_init.cfg")
}

data "template_file" "network_config" {
  template = file("${path.module}/network_config.cfg")
}

resource "libvirt_cloudinit_disk" "commoninit" {
  name           = "commoninit.iso"
  user_data      = data.template_file.user_data.rendered
  network_config = data.template_file.network_config.rendered
}

resource "libvirt_domain" "homeassistant" {
  name      = "test-ha"
  vcpu      = 1
  memory    = "1024"

  cloudinit = libvirt_cloudinit_disk.commoninit.id

  network_interface {
    network_name = "default"
  }

  console {
    type        = "pty"
    target_port = "0"
    target_type = "serial"
  }

  console {
    type        = "pty"
    target_type = "virtio"
    target_port = "1"
  }

  disk {
    volume_id = libvirt_volume.home_assistant-qcow2.id
  }
}
```

I'll cover more about `cloud_init.cfg` and `network_config.cfg` we just saw above in a while. To transform this text file into a running VM there were some problems. 

First, I was using Debian 10 to run terraform, and it did not had a _symlink_ to `mkisofs`, which is necessary to generate the _cloud init_ ISO. There is [a discussion](https://github.com/dmacvicar/terraform-provider-libvirt/issues/465) on the libvirt provider github about this issue, but it was also [marked as a bug on Debian](https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=680949), and all I needed to do was creating a [_symlink_ from _xorriso_ to _mkisofs_](https://github.com/dmacvicar/terraform-provider-libvirt/issues/465#issuecomment-591095927). From what I tested on debian 11 this was fixed already, I do not know if there is a fix on the way for 10.

Once the VM was successfully created, the problem was booting it up. For some reason `apparmor` was blocking the hypervisor from using an image from a pool, but not when a file was directly referenced.

apparmor error
https://github.com/dmacvicar/terraform-provider-libvirt/issues/97
    FILE WORKS
Sep 12 19:03:51 homelab kernel: audit: type=1400 audit(1631484231.392:101): apparmor="DENIED" operation="open" profile="libvirt-a2a6e813-e14e-4d5c-9981-47adc7b5dca6" name="/home/carlos/volumes/homeassistant-qcow2" pid=8178 comm="qemu-system-x86" requested_mask="r" denied_mask="r" fsuid=64055 ouid=64055
Sep 12 19:03:51 homelab kernel: audit: type=1400 audit(1631484231.392:102): apparmor="DENIED" operation="open" profile="libvirt-a2a6e813-e14e-4d5c-9981-47adc7b5dca6" name="/home/carlos/volumes/homeassistant-qcow2" pid=8178 comm="qemu-system-x86" requested_mask="wr" denied_mask="wr" fsuid=64055 ouid=64055
Sep 12 19:03:51 homelab kernel: audit: type=1400 audit(1631484231.392:103): apparmor="DENIED" operation="open" profile="libvirt-a2a6e813-e14e-4d5c-9981-47adc7b5dca6" name="/home/carlos/volumes/homeassistant-qcow2" pid=8178 comm="qemu-system-x86" requested_mask="r" denied_mask="r" fsuid=64055 ouid=64055




## Bootstrapping Home Assistant with Ansible

