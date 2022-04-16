---
layout: post
title:  "integrating kvm with the home app - vmsm on k8s"
date:   2021-08-07 12:05:00 -0300
categories: homelab
image: /assets/integrating-kvm-apple-home/vfio-ha.jpeg
tags: ["kvm", "homeassistant", "kubernetes"]
---
_(Code available at [github](https://github.com/cmillani/vmsm))_

Besides running some nodes on my homelab k8s cluster, my newest server is also my video game console.

When building it I started searching for ways to game on a virtual machine, and though the help of the [Arch wiki](https://wiki.archlinux.org/title/PCI_passthrough_via_OVMF) and [Reddit VFIO sub](https://reddit.com/r/VFIO/) I knew it was possible. After some weekends tinkering with the configurations (those two links helped me a lot!) I was able to run some games!

The aim of this post is not discussing how to do it, there are many wonderful tutorials out there, this text is about the annoying part that was to turn my new "console" on. I had to either ssh to the host using my personal computer, or navigate to the [cockpit](https://cockpit-project.org) interface to turn it on. 

I wanted to turn it on with a button, but creating some hardware for this simple purpose seemed too much, so I went to the other option o thought of: integrating it with the smart home app available on my phone.

## Exposing VM power control outside the host

HomeKit was opensourced some time ago, so it became possible to build custom devices integrated with the iPhone app. [Home Assistant](https://www.home-assistant.io) provides an easy way to build a smart home, and has a way to integrate with HomeKit, all I needed now was to create some way to let Home Assistant turn my gaming VM on and off.

I made a quick look into something similar to what I needed but was not able to find it. The next step was looking into how to implement it, and I immediately found the [libvirt API](https://libvirt.org). Reading quickly through the docs I found that it was possible to do what I wanted and much more, so I started coding.

## Implementing a web API using libvirt

My goal was creating something simple and quick that provided the desired functionality, so I choose a language that would allow me to do that with few lines (and also, I wanted to do something in python for a while now). My intention was to create a minimal layer to call libvirt methods though HTTP endpoints, so the first thing I did was to understand the basic of libvirt.

# Querying a VM status

First thing was trying to connect to KVM. I try to keep my hosts as minimal as possible by installing any services into a VM or my k8s cluster, so I needed a way to control the virtual machines from outside. Libvirt connects to a hypervisor thought a [connection string](https://libvirt.org/uri.html), this allows us to specify which hypervisor we are using, and also how should we connect to them (the transport method). In my case, `qemu` is the hypervisor, and `ssh` was the transport that made the remote part possible, so I started with something like:

```python
import libvirt

conn = libvirt.open('qemu+ssh://carlos@192.168.1.6/system')
```
_More about the '/system' can be read [here](https://blog.wikichoon.com/2016/01/qemusystem-vs-qemusession.html). I first went with trial and error, and am now reading more about it :p_

This gave me the following output:

```
carlos@192.168.1.6's password:
```

Ok, I need to configure authentication so it does not ask the user. Since ssh by default looks at `~/.ssh/id_rsa`(and some other files) this was my first try, generating a key and configuring the host to accept it. After executing `ssh-keygen` (to create a key) and `ssh-copy-id` (to copy it to the host) I could now execute the code above with success.

How do I query the VMs now? Well, following the docs, I can lookup by name, and the method `isActive` should return if the VM is on or not. Adding some code, where `debtest` is the name of a testing vm I have:

```python
import libvirt

conn = libvirt.open('qemu+ssh://carlos@192.168.1.6/system')
domain = conn.lookupByName('debtest')
print(domain.isActive())
```
This code outputs `0` if the VM is off, and `1` if it is on.

This was the base for `GET /videogame` endpoint, that returned if it was already on or not. To complete the API, the other methods needed were `create` and `shutdown` that, respectively, starts and shuts down the VM for the given domain object.

# Hosting the new service

I did not want a whole new VM for this small service, so I started creating a container image for it. The first problem that I faced is that on the first connection to a new host the authenticity is checked, and if the host is not known the following is returned for the script above:

```
The authenticity of host '192.168.1.6 (192.168.1.6)' can't be established.
ECDSA key fingerprint is SHA256:<SHA>.
Are you sure you want to continue connecting (yes/no)?
```
And it waits for user input. The quick and dirty solution for bypassing that without needing additional configuration was to add something to the connection string:
```
qemu+ssh://carlos@192.168.1.6/system?no_verify=1
```

The `no-verify` removes a bit of security, so it is not ideal, but for a first version it avoided additional configuration.

Also, to make the container be able to use ssh, I mounted a volume and pointed the client to look there for private keys, this gave me my final connection string:

```
qemu+ssh://carlos@192.168.1.6/system?keyfile=/ssh/id_rsa&no_verify=1
```

With this, container version that exposed the `domain.isActive()`, `domain.create()` and `domain.shutdown()` was created. I could now create some resource configurations for my k8s cluster.

It was a simple setup: a `deployment` with one replica loading my just-built image, a `persistent-volume` to hold the ssh key and a `persistent-volume-claim` to mount the volume to the pod of the deployment, a `service` to give it a name and an `ingress` to expose it to outside the cluster. The full configuration looked something like this:

```yaml
apiVersion: v1
kind: Service
metadata:
  namespace: vmsm
  name: vmsm
  labels:
    app: vmsm
spec:
  ports:
    - port: 80
      targetPort: 5000
      name: vmsm
  selector:
    app: vmsm
    tier: frontend
  type: ClusterIP
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  namespace: vmsm
  name: vmsm-ssh-claim
  labels:
    app: vmsm
spec:
  storageClassName: ""
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: vmsm
  name: vmsm
  labels:
    app: vmsm
spec:
  selector:
    matchLabels:
      app: vmsm
      tier: frontend
  strategy:
    type: Recreate
  template:
    metadata:
      labels:
        app: vmsm
        tier: frontend
    spec:
      containers:
      - image: cmillani/vmsm:1.0.0
        name: vmsm
        resources:
          requests:
            memory: "50Mi"
            cpu: "50m"
          limits:
            memory: "150Mi"
            cpu: "100m"
        env:
        - name: CONNSTRING
          value: qemu+ssh://carlos@192.168.1.6/system?keyfile=/ssh/id_rsa&no_verify=1
        - name: VMNAME
          value: kubuntu_gaming
        ports:
        - containerPort: 5000
          name: vmsm
        volumeMounts:
        - mountPath: "/ssh"
          name: vmsm-ssh
        imagePullPolicy: Always
      volumes:
        - name: vmsm-ssh
          persistentVolumeClaim:
            claimName: vmsm-ssh-claim
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  namespace: vmsm
  annotations:
    cert-manager.io/cluster-issuer: cloudflare-letsencrypt-issuer
  name: vmsm-ingress
spec:
  rules:
  - host: vmsm.homelab.cadumillani.com.br
    http:
      paths:
      - backend:
          service:
            name: vmsm
            port:
              number: 80
        path: /
        pathType: Prefix
  tls:
  - hosts:
    - vmsm.homelab.cadumillani.com.br
    secretName: vmsm-ingress-cert 
```

It uses the previous configured `cert-manager` (I wrote about it [here]({% post_url 2021-07-18-lets-encrypt-on-k8s %})), and a `PersistantVolume` I configured with `NFS` like the following:

> See [Updates](#updates) section at the end for a better way to mount the key

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: nfs-host-pv-1
spec:
  capacity:
    storage: 10Gi
  accessModes:
    - ReadWriteMany
  nfs:
    server: 192.168.1.5
    path: "/home/carlos/pvs/pv_1"
```

On the folder referenced by the `PV` I put the ssh key.

## Using the API from HomeAssistant

The next step was creating some kind of device on Home Assistant to use our new API, that device had to somehow integrate with Home Assistant. [HomeKit integration](https://www.home-assistant.io/integrations/homekit/#supported-components) supports a list of components, and from that list, `switch` was the one the fit the best, and to my luck there was already a [RESTful Switch](https://www.home-assistant.io/integrations/switch.rest/) I could use.

With that base, I simply needed to define my switch on HA:

``` yaml
switch:
  - platform: rest
    name: Videogame
    resource: <SERVER_URL>/videogame
    body_on: '{"active": true}'
    body_off: '{"active": false}'
    is_on_template: {% raw %}'{{ value_json.is_active }}'{% endraw %}
    headers:
      Content-Type: application/json
    verify_ssl: false # Needed if https cert is not trusted
```

## Conclusion

It works!

![Video game console on Home app](/assets/integrating-kvm-apple-home/vfio-ha.jpeg)

There are some points that could be improved:
* Bypassing the ssh validation with `no_verify` is not great
* A minimal authentication (even basic-auth) would do no harm...
* It currently handles just one VM
* It is not "resource-smart": if other VMs share the same hardware (i.e. gpu passthrough), turning on the gaming VM will fail

But it is really really good to call Siri to turn my VM on!

## Updates

No longer using a PV (finally :D)!

By creating a secret with a base64 encoded private key
```yaml
apiVersion: v1
kind: Secret
metadata:
  namespace: vmsm
  name: vmsm-ssh-secret
type: kubernetes.io/ssh-auth
data:
  id-rsa: BASE-64-PRIVATE-KEY
```

and changing the way we mount the volume (both parts of the `Deployment` resource):

First set to use data from the secret, and configure only READ permissions (mode 0400), needed by ssh

```yaml
      volumes:
        - name: vmsm-ssh
          secret:
            secretName: vmsm-ssh-secret
            defaultMode: 0400 
```
and added readOnly to the volume mount
```yaml
        volumeMounts:
        - mountPath: "/ssh"
          readOnly: true
          name: vmsm-ssh
```

we are able to insert the secret into the right path without the complexity of configuring a PV and PVC.