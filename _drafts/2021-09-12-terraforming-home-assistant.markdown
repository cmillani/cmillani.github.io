---
layout: post
title:  "provisioning home assistant with terraform and ansible"
date:   2021-12-18 19:05:00 -0300
categories: infra
tags: ["terraform", "ansible", "homeassistant", "cloud-init", "debian"]
---

Earlier this month my [home assistant](https://www.home-assistant.io) installation broke. During an auto-update something went wrong and the system was left in a state where I could not bring that back. I am using Home Assistant Supervised on a Debian VM, and there are [some warnings](https://www.home-assistant.io/installation/linux#install-home-assistant-supervised) about this kind of setup.

Well, after some attempts to bring the service back to life I decided to take this as an opportunity to learn a little bit of some automation tools. On the next session I'll describe which tools and why, and then the steps I used to provision my instance of Home Assistant.

> I'll show some versions of the scripts I used, if you are only interested on the final scripts, scroll to the end ;)

## The right tool for the right job

At first I intended on using [Terraform](https://www.terraform.io) to create the VMs **and** install Home Assistant, but after reading a little about this tool it seemed like that was not a good idea. The installation part was not connecting very well with what I just read. That is where [Ansible](https://www.ansible.com) comes to play.

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

resource "libvirt_volume" "ubuntu-qcow2" {
  name   = "homeassistant-qcow2"
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
    volume_id = libvirt_volume.ubuntu-qcow2.id
  }
}
```

I'll cover more about `cloud_init.cfg` and `network_config.cfg` we just saw above in a while. To transform the text file above into a running VM there were some problems. 

First, I was using Debian 10 to run terraform, and it did not had a _symlink_ to `mkisofs`, which is necessary to generate the _cloud init_ ISO. There is [a discussion](https://github.com/dmacvicar/terraform-provider-libvirt/issues/465) on the libvirt provider github about this issue, but it was also [marked as a bug on Debian](https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=680949), and all I needed to do was creating a [_symlink_ from _xorriso_ to _mkisofs_](https://github.com/dmacvicar/terraform-provider-libvirt/issues/465#issuecomment-591095927). From what I tested on debian 11 this was fixed already, I do not know if there is a fix on the way for 10.

Once the VM was successfully created, the problem was booting it up. For some reason `apparmor` was blocking the hypervisor from using an image from a pool, but not when a file was directly referenced. The dirty and quick fix is described [here](https://github.com/dmacvicar/terraform-provider-libvirt/commit/22f096d9), and is basically turning apparmor off. I'm curious if there is some configuration to fix this, but I could not find any in the short time I searched, and although I was running libvirt 5.0.0 on the first time I tested, on libvirt 7.0.0 the issue is still there. If instead of a pool we referenced a file, the issue would not appear.

Just a bit more of detail, from the logs we could see:

```log
Sep 12 19:03:51 homelab kernel: audit: type=1400 audit(1631484231.392:101): apparmor="DENIED" operation="open" profile="libvirt-a2a6e813-e14e-4d5c-9981-47adc7b5dca6" name="/home/carlos/volumes/homeassistant-qcow2" pid=8178 comm="qemu-system-x86" requested_mask="r" denied_mask="r" fsuid=64055 ouid=64055
Sep 12 19:03:51 homelab kernel: audit: type=1400 audit(1631484231.392:102): apparmor="DENIED" operation="open" profile="libvirt-a2a6e813-e14e-4d5c-9981-47adc7b5dca6" name="/home/carlos/volumes/homeassistant-qcow2" pid=8178 comm="qemu-system-x86" requested_mask="wr" denied_mask="wr" fsuid=64055 ouid=64055
Sep 12 19:03:51 homelab kernel: audit: type=1400 audit(1631484231.392:103): apparmor="DENIED" operation="open" profile="libvirt-a2a6e813-e14e-4d5c-9981-47adc7b5dca6" name="/home/carlos/volumes/homeassistant-qcow2" pid=8178 comm="qemu-system-x86" requested_mask="r" denied_mask="r" fsuid=64055 ouid=64055
```

### Setting up the basics of the VM

The script above used defined `resource "libvirt_volume" "ubuntu-qcow2"` directly from the base image, and the created VM has de exact same disk size of the `iso`. I tried to change the `size` property from the volume, but that rendered an error when applying the `tf` script.

Reading a little bit more the [docs](https://registry.terraform.io/providers/dmacvicar/libvirt/latest/docs/resources/volume) I found this:
> If size is specified to be bigger than base_volume_id or base_volume_name size, you can use cloudinit if your OS supports it, with libvirt_cloudinit_disk and the growpart module to resize the partition.

If that information, I isolated the base image on another `terraform` file, defining a base image: 
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

resource "libvirt_pool" "base_images" {
  name = "base_images"
  type = "dir"
  path = "/home/carlos/base"
}

resource "libvirt_volume" "debian-cloud" {
  name   = "debian-cloud-qcow2"
  pool   = libvirt_pool.base_images.name
  source = "http://cloud.debian.org/images/cloud/bullseye/latest/debian-11-genericcloud-amd64.qcow2"
  format = "qcow2"
}

resource "libvirt_volume" "ubuntu-cloud" {
  name   = "ubuntu-cloud-qcow2"
  pool   = libvirt_pool.base_images.name
  source = "https://cloud-images.ubuntu.com/focal/current/focal-server-cloudimg-amd64-disk-kvm.img"
  format = "qcow2"
}
```

And then moved to using `base_volume_name` I defined a new volume with the base image, and now my `homeassistant` image would use that as a base: 
```tf
resource "libvirt_pool" "home_assistant" {
  name = "home_assistant"
  type = "dir"
  path = "/home/carlos/volumes"
}

resource "libvirt_volume" "home_assistant-qcow2" {
  name   = "homeassistant-qcow2"
  pool   = libvirt_pool.home_assistant.name
  base_volume_name = "debian-cloud-qcow2"
  base_volume_pool = "base_images"
  size = 21474836480
  format = "qcow2"
}
```

According to [`Growpart` docs](https://cloudinit.readthedocs.io/en/latest/topics/modules.html#growpart):
> Growpart is enabled by default on the root partition.

After removing all the resources created before and running `terraform apply` again, I could login into the newly created VM and see that indeed the disk adapted without any further configuration!

```bash
$ df
Filesystem     1K-blocks   Used Available Use% Mounted on
udev              234220      0    234220   0% /dev
tmpfs              48700    444     48256   1% /run
/dev/vda1       20480580 646100  18964844   4% /
tmpfs             243492      0    243492   0% /dev/shm
tmpfs               5120      0      5120   0% /run/lock
/dev/vda15        126678   6016    120662   5% /boot/efi
tmpfs              48696      0     48696   0% /run/user/1000
```

Now, I only need to be able to access this VM from my whole LAN and also to be able to `SSH` into it. Until now I was letting the hypervisor assign an IP, which was only accessible from within the Host, and I manually setup a password inside my `cloud_init.cfg` using the [`chpasswd` module](https://cloudinit.readthedocs.io/en/latest/topics/modules.html#set-passwords).

For the `SSH` part I will modify our template a little so we can read the `id_rsa.pub` from my machine inside the `cloud_init.cfg`. The documentation around those tools are really helping. Searching template for _terraform template_ leads me to [this page](https://www.terraform.io/docs/language/functions/templatefile.html), and with this I can also replace the `template_file` resources, following [the recomendation](https://registry.terraform.io/providers/hashicorp/template/latest/docs/data-sources/file).

The changes to the `terraform` file looked like:

> I'll talk about the `network_config` in a while!

```tf
variable "ipv4_address" {
  type        = string
  default     = "192.168.1.116"
  description = "IPV4 Address to be assigned to the new VM"
}

variable "public_key_path" {
  type        = string
  default     = "/home/carlos/.ssh/id_rsa.pub"
  description = "Public key to be installed to guests"
}

resource "libvirt_cloudinit_disk" "commoninit" {
  name           = "commoninit.iso"
  pool           = libvirt_pool.home_assistant.name
  user_data      = templatefile("${path.module}/cloud_init.cfg", { 
    SSH_PUB_KEY: file(var.public_key_path)
  })
  network_config = templatefile("${path.module}/network_config.cfg", {
    IPV4_ADDR: var.ipv4_address
  })
}
```

And cloud init:

```
hostname: homeassistant

users:
  - name: carlos
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh-authorized-keys:
      - ${SSH_PUB_KEY}
```

Well, this is one point where the documentation tricked me. Searching the [examples](https://cloudinit.readthedocs.io/en/latest/topics/examples.html) I could find several setups with a `ssh_authorized_keys` parameter, but it simply did not work. Later on I discovered that `ssh-authorized-keys` (note the underscore _vs_ hyphen) was the one I was looking for. While debugging this, `virsh console` was my friend since I was having trouble with ssh.

I was seeing something like this:
```log
2021-10-11 18:35:47,565 - util.py[WARNING]: Failed to run command to import carlos SSH ids
2021-10-11 18:35:47,565 - util.py[DEBUG]: Failed to run command to import carlos SSH ids
```

Fortunately, I found the `hyphen` difference (by accident) before going through the `write_files` route, simply copying the files manually.

Other configuration that was tackled with `cloud_init` was setting the default IP. Currently, I bridge the host network to the guests, and I wanted to have a predefined IP configured, so it would be easier to follow up with commands. This required a change to a part of `cloud_init`'s configuration and `libvirt_domain`'s `network_interface`.

Thankfully, on terraform script I just had to change the `network_interface` to:
```tf
network_interface {
  bridge = "kvm_br0"
}
```

where _"kvm_br0"_ is the name of the bridge on the host, and on cloud init, I configured the `network_config`:

```cfg
version: 2
ethernets:
  ens3:
    renderer: NetworkManager
    addresses: [${IPV4_ADDR}]
    gateway4: 192.168.1.1
    nameservers: 
      search: [lab, home]
      addresses: [192.168.1.242, 192.168.1.1]
```

The IP (`${IPV4_ADDR}`) was templated, and I just configured the DNS servers. One important part was setting `renderer: NetworkManager`, since HomeAssistant's Supervisor manages `NetworkManager` and my cloud image came without this service. This also required an additional part on `cloud_init.cfg`:

```
packages:
  - network-manager
```

With the VM up and running, the the desired configurations, let's install Home Assistant with Ansible.

## Bootstrapping Home Assistant with Ansible

First of all, I [installed ansible using pip](https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html#installing-and-upgrading-ansible-with-pip) (with `apt` on my debian 10 I was getting a very old version, and had [a problem](https://github.com/ansible/ansible/issues/48055), so I opted for _pip_), then I configured my host on `/etc/ansible/hosts`, adding:

```
192.168.1.116 ansible_python_interpreter=/usr/bin/python3
```

After that, with my VM on, I could try it:
```console
$ ansible all -m ping
192.168.1.116 | SUCCESS => {
    "changed": false,
    "ping": "pong"
}
```

The `python` path was needed since ansible was trying to use python, which was not defined (ok, later I discovered that this is not an issue on newer ansible versions). Following Home Assistant Supervised [installation instructions](https://www.home-assistant.io/installation/linux#install-home-assistant-supervised) I started defining the playbook.

During the process, I had to programmatically retrieve the url of the last version of a github package, [this blog post](https://gist.github.com/steinwaywhw/a4cd19cda655b8249d908261a62687f8) helped me achieve an one-liner to download:
```
curl -s https://api.github.com/repos/home-assistant/os-agent/releases/latest | jq -r ".assets[] | select(.name | contains(\"x86_64\")) | .browser_download_url"
```

And [this other post](https://chaosmail.github.io/programming/2015/03/04/install-deb-packages-in-ansible/) helped me find better ways to download and install the `deb` files used during the process.

Installing all needed packages was as simples as

```yaml
---
- name: Test
  become: true
  hosts: all
  tasks:
    - name: Install Docker Dependencies
      apt: 
        name: "{% raw %}{{ item }}{% endraw %}"
        state: latest
        update_cache: yes
      loop: ['apt-transport-https', 'ca-certificates', 'curl', 'gnupg', 'lsb-release']
    - name: Add Docker GPG Key
      apt_key: 
        url: https://download.docker.com/linux/debian/gpg
        state: present
    - name: Add Docker Repository
      apt_repository:
        repo: deb https://download.docker.com/linux/debian bullseye stable
        state: present
    - name: Install Docker
      apt: 
        name: "{% raw %}{{ item }}{% endraw %}"
        state: latest
        update_cache: yes
      loop: ['docker-ce', 'docker-ce-cli', 'containerd.io']
    - name: Install Additional Dependencies
      apt: 
        name: "{% raw %}{{ item }}{% endraw %}"
        state: latest
        update_cache: yes
      loop: ['jq','wget','curl','udisks2','libglib2.0-bin','network-manager','dbus', 'rsync']
    # Prepares folder for downloads
    - name: Create a directory if it does not exist
      file:
        path: /opt/haosagent
        state: directory
        mode: '0755'
      register: folder
    # Installs OS_Agent
    - name: Get os_agent URL
      shell: 
        cmd: curl -s https://api.github.com/repos/home-assistant/os-agent/releases/latest | jq -r ".assets[] | select(.name | contains(\"x86_64\")) | .browser_download_url"
        warn: False # Only want output name, we are not downloading anything
      register: os_agent_url
    - name: Download os_agent
      get_url: 
        url="{% raw %}{{ os_agent_url.stdout }}{% endraw %}"
        dest="{% raw %}{{ folder.path }}{% endraw %}" # Download to folder so we can use "Changed" status
      register: os_agent_path
    - name: Install os_agent
      apt: deb="{% raw %}{{os_agent_path.dest}}{% endraw %}"
      when: os_agent_path.changed
    # Installs Supervisor
    - name: Download supervisor
      get_url: 
        url="https://github.com/home-assistant/supervised-installer/releases/latest/download/homeassistant-supervised.deb"
        dest="{% raw %}{{ folder.path }}{% endraw %}" # Download to folder so we can use "Changed" status
      register: supervisor_path
    - name: Install supervisor
      apt: deb="{% raw %}{{supervisor_path.dest}}{% endraw %}"
      when: supervisor_path.changed
```

Some important notes:
* HA Supervised has a list of [requirements](https://github.com/home-assistant/architecture/blob/master/adr/0014-home-assistant-supervised.md), but all those configurations were defaults at the time of writing this, so I did not bother to make sure (if this was a critical production setup, that would be a good idea)
* `get_url` when a _folder_ is specified it will always download and check the hash to determine if the file was modified. Adding a `register` to this task will save the file name and a `changed` variable, so I can call the installation task conditionally, so running the playbook again will _theoretically_ (I still need to test this with a future release) update the package.
* before any download I call the `file` task to make sure there is a folder where I can save the packages

All other tasks are simply installing dependencies.

## Restoring the backup

I do not have any backup system (bad, yeah :/) but I was able to retrieve some basic configurations files to save me from the trouble. Once I build some decent backup mechanism this step will probably change, but for now, a simple `rsync` is enough, so I added:

```
- name: Restore HA Backup
  synchronize:
    src: /home/carlos/backups/homeassistant
    dest: /usr/share/hassio/
    recursive: yes
```

## Bringing Terraform and Ansible together

At the end of terraforming I want to be able to run my playbook on the target host, this can be done with a `provisioner "local-exec"` inside my `resource "libvirt_domain"`. But hey:

```console
fatal: [192.168.1.116]: UNREACHABLE! => {"changed": false, "msg": "Failed to connect to the host via ssh: ssh: connect to host 192.168.1.116 port 22: No
│ route to host", "unreachable": true}
```

I need to wait until the VM is up and running before executing ansible. The kvm provider I am using does provide a parameter _wait_for_lease_ to wait for a DHCP lease, but since I am hard coding the networking configurations (eventually I want to setup a better network at home, but for now...), I had to improvise with ansible. Setting `gather_facts: no` and adding a `wait_for_connection` task did the trick, and I just moved `gather_facts` to just after the connection has been established:

```yaml
- name: Test
  become: true
  hosts: all
  gather_facts: no
  tasks:
    - name: Wait 600 seconds for target connection to become reachable/usable
      wait_for_connection:
    - name: Gathering facts
      setup:
...
```

And added to terraform:
```tf
provisioner "local-exec" {
  command = "ANSIBLE_HOST_KEY_CHECKING=False ansible-playbook -i '${var.ipv4_address},' --private-key ${var.private_key_path} -e 'pub_key=${var.public_key_path}' test.yml"
}
```

When trying to install _apt_ packages right after booting for the first time I was stumbling upon a locked apt. There is a `lock_timeout` parameter configured, but it seems to miss `/var/lib/dpkg/lock-frontend`, which is locked when it runs. There are workarounds that suggest looking for _cloud-init_ messages at the journal (which is too specific), and it seems like a bug on `lock_timeout`. Looking at the code, it checks for a `LockFailedException` on [python-apt](https://launchpad.net/python-apt/), but for some reason, it does not appear to be working. I looked around a little bit around the package's code and debian's open bugs, but no relevant information was there, so for now I'll be going around this. Maybe my next blog post will be a little more about apt's lock mechanism :)


https://github.com/ansible/ansible/issues/25414#issuecomment-963230921
So this other task was added:

```yaml
- name: Wait for dpkg locks
  shell: while fuser /var/lib/dpkg/{{ item }} >/dev/null 2>&1; do sleep 1; done;
  with_items:
    - lock
    - lock-frontend
```

Did not work. New attempt, following example https://docs.ansible.com/ansible/latest/collections/community/general/cloud_init_data_facts_module.html#examples:

```yaml
- name: Wait for cloud init to finish
  community.general.cloud_init_data_facts:
    filter: status
  register: res
  until: "res.cloud_init_data_facts.status.v1.stage is defined and not res.cloud_init_data_facts.status.v1.stage"
  retries: 50
  delay: 5
```

Also not reliable - worked once, failed another time. I could not find the documentation to the output of `cloud_init_data_facts`, so I tried yet another route: cloud init has a `cli` with a status command that has a _wait_ parameter that, according to docs, will block until completion. That allied with a hardcoded check (not ideal, but as a first version of this script will be enough), allowed a more reliable wait (as far as I could tell):

```yaml
- name: Wait cloud init success
  ansible.builtin.shell:
    cmd: cloud-init status --wait
  register: cinitres
  failed_when: '"status: done" not in cinitres.stdout'
```

# Finally, restoring

With a newly created HomeAssistant instance, I now need to restore backup somehow. There is a [`cli` tool](https://www.home-assistant.io/common-tasks/os/#creating-backup-using-the-home-assistant-command-line-interface) that handles that, so I went in this direction. Once again, I run into some timing problems: I needed to wait until _homeassistant_ started before trying to restore. CLI command `backups` failed saying a needed container was not running, so my solution was to repeat that command until I received a status code _0_, and then restored backup:

> Important, I needed to wait before copying the backup too, or else _supervisor_ would detect the _backup_ folder and fail startup

```yaml
- name: Wait Hassio Setup
  ansible.builtin.shell:
    cmd: ha backups
  register: ha_cli_status
  until: ha_cli_status is success
  delay: 10
  retries: 300
- name: Synchronization of src on the control machine to dest on the remote hosts
  synchronize:
    src: /home/carlos/backups/111cfc64.tar
    dest: /usr/share/hassio/backup
- name: Restore backup
  ansible.builtin.shell:
    cmd: ha backups reload && ha backups restore 111cfc64
```

And done! Whole thing took 7 minutes to run, and now I can wipe the VM clean and start again anytime, but more important, this is the base to expand IaC to other services on my homelab.

## Conclusion
20hours to save 30 minutes, yay!
But built up knowledge to automate setup of other tasks I intend to.


## Summing Up
Terraform -> KVM + CloudInit to bootstrap a debian with configured network and ssh
Ansible called from terraform, with proper waits in place and then installs everything and restores backup
