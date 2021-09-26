---
layout: post
title:  "external dns: the missing piece for my automated homelab infra"
date:   2021-09-25 19:05:00 -0300
categories: infra
---

I've been using kubernetes to host some services at home for a while, and since all are only accessible from my LAN I just went to my router and added a static DNS mapping to the IP of my ingress controller. Then I began to wonder if there wasn't a way to do this at scale, and that is when I met [external dns](https://github.com/kubernetes-sigs/external-dns). And, since I am totally on prem on this adventure, I decided to try that with [CoreDNS](https://coredns.io).

The idea here is: given that I already have the infrastructure (kubernetes cluster with all cluster services configured), I want to deploy and make a whole new service accessible with kubernetes yaml files, this way, a team developing some piece of software could have total control over the environment, no need to manually enter a DNS entry.

This text will briefly describe my setup, I'll add some reference `yaml` files and links, most of them put together from documentations from those tools.

## Installing CoreDNS

The [tutorial](https://github.com/kubernetes-sigs/external-dns/blob/master/docs/tutorials/coredns.md) for integrating External DNS CoreDNS guides to install CoreDNS with [etcd](https://etcd.io). Investigating more at implementation of this provider it seems that [this is necessary](https://github.com/kubernetes-sigs/external-dns/blob/master/provider/coredns/coredns.go#L249), as at the time of this writing I could only find one constructor, and it used the ETCD parameters. So, the first step for me would be configuring an etcd deployment.

# Configuring ETCD
The [referenced etcd operator](https://github.com/coreos/etcd-operator) is archived on github, and last commit dates to 2 years ago. Since I don't need anything much complex, I tried to roll my own deployment. **Note that this is not suitable for production**, since the following configuration provides a single instance, without secure communication (and probably other not-optimal configurations).

```yaml
apiVersion: v1
kind: Service
metadata:
  namespace: dnstools
  name: dns-etcd
  labels:
    app: dns-etcd
spec:
  ports:
    - port: 2380
      targetPort: 2380
      name: clientreq
    - port: 2379
      targetPort: 2379
      name: peercomm
  selector:
    app: dns-etcd
  type: ClusterIP
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  namespace: dnstools
  name: dns-etcd-claim
  labels:
    app: dns-etcd
spec:
  storageClassName: "" # I use a NFS PV, if in a cloud, the class name could be used make the instantiation on the PV easier 
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: dnstools
  name: dns-etcd
  labels:
    app: dns-etcd
spec:
  selector:
    matchLabels:
      app: dns-etcd
  strategy:
    type: Recreate
  template:
    metadata:
      labels:
        app: dns-etcd
    spec:
      containers:
      - image: quay.io/coreos/etcd:v3.5.0
        name: dns-etcd
        command: ["/usr/local/bin/etcd"]
        args:
          - --name 
          - s1
          - --data-dir 
          - /etcd-data
          - --listen-client-urls 
          - http://0.0.0.0:2379
          - --advertise-client-urls 
          - http://0.0.0.0:2379
          - --listen-peer-urls 
          - http://0.0.0.0:2380
          - --initial-advertise-peer-urls 
          - http://0.0.0.0:2380
          - --initial-cluster 
          - s1=http://0.0.0.0:2380
          - --initial-cluster-token 
          - tkn
          - --initial-cluster-state 
          - new
          - --log-level 
          - info
          - --logger 
          - zap
          - --log-outputs 
          - stderr
        resources:
          requests:
            memory: "50Mi"
            cpu: "50m"
          limits:
            memory: "150Mi"
            cpu: "100m"
        ports:
        - containerPort: 2379
          name: clientreq
        - containerPort: 2380
          name: peercomm
        volumeMounts:
        - mountPath: "/ssh"
          name: dns-etcd-storage
        imagePullPolicy: Always
        livenessProbe:
          httpGet:
            path: /health
            port: 2379
          initialDelaySeconds: 3
          failureThreshold: 3
          timeoutSeconds: 1
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 2379
          initialDelaySeconds: 3
          failureThreshold: 3
          timeoutSeconds: 1
          periodSeconds: 10
      volumes:
        - name: dns-etcd-storage
          persistentVolumeClaim:
            claimName: dns-etcd-claim     
```

Again, **this should be not used in production, only for tests**. This yaml was based on the release [test instructions for docker](https://github.com/etcd-io/etcd/releases/tag/v3.5.0). After this, we can follow the instructions and test that the single instance of this test etcd is up.

First of all, we get the cluster ip of the service.
```console
carlos@homelab:~$ kubects get svc 
NAME              TYPE           CLUSTER-IP      EXTERNAL-IP     PORT(S)                     AGE
dns-etcd          ClusterIP      10.103.39.133   <none>          2380/TCP,2379/TCP           3h50m
```
Then, we create a test pod inside the cluster so we can access the IP, and test it
```console
carlos@homelab:~$ kubectl run -it --rm --restart=Never --image=quay.io/coreos/etcd:v3.5.0 etcdctl -- /bin/sh
# /usr/local/bin/etcdctl --endpoints=10.103.39.133:2379 endpoint health
10.103.39.133:2379 is healthy: successfully committed proposal: took = 3.310883ms
```

# Installing CoreDNS

The [external DNS tutorial](https://github.com/kubernetes-sigs/external-dns/blob/master/docs/tutorials/coredns.md) is a little out of date, the helm chart it points to is no longer maintained, so I went to the `CoreDNS` repository and got the file from there:
```sh
wget https://raw.githubusercontent.com/coredns/helm/70519f776a9175db2b429b7b39625262c273180d/charts/coredns/values.yaml
```
I used the specific commit in the link above so the diff bellow will still make sense, but you should take a look at the master branch to check for updates when applying this.

The only thing I changed besides what is pointed in the original tutorial was setting the Service to `LoadBalancer` so [MetalLB](https://metallb.universe.tf) (already configured on my cluster) would give this service an IP that I can reach from my LAN. This is the final diff I used:

```diff
diff --git a/k8s/dns/values.yaml b/k8s/dns/values.yaml
index c952736..e5ce8e2 100644
--- a/k8s/dns/values.yaml
+++ b/k8s/dns/values.yaml
@@ -51,7 +51,7 @@ terminationGracePeriodSeconds: 30
 podAnnotations: {}
 #  cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
 
-serviceType: "ClusterIP"
+serviceType: "LoadBalancer"
 
 prometheus:
   service:
@@ -91,7 +91,7 @@ rbac:
   # name:
 
 # isClusterService specifies whether chart should be deployed as cluster-service or normal k8s app.
-isClusterService: true
+isClusterService: false
 
 # Optional priority class to be used for the coredns pods. Used for autoscaler if autoscaler.priorityClassName not set.
 priorityClassName: ""
@@ -127,6 +127,12 @@ servers:
   - name: loop
   - name: reload
   - name: loadbalance
+  - name: etcd
+    parameters: example.org
+    configBlock: |-
+      stubzones
+      path /skydns
+      endpoint http://10.105.68.165:2379
 
 # Complete example with all the options:
 # - zones:                 # the `zones` block can be left out entirely, defaults to "."

```

The ip after `endpoint` on the `configBlock` is the one we got from `CLUSTER-IP` when running `kubectl get pods`.

After this, I can simply run:
```sh
helm repo add coredns https://coredns.github.io/helm
helm repo update
helm install -n dnstools coredns -f values.yaml coredns/coredns
```

Since the default `values.yaml` did include the `forward` plugin we can test the server with a valid domain.

First, we get the external ip:
```console
carlos@homelab:~$ $ kubectl get svc
NAME              TYPE           CLUSTER-IP      EXTERNAL-IP     PORT(S)                     AGE
coredns-coredns   LoadBalancer   10.109.128.84   192.168.1.242   53:31234/UDP,53:31191/TCP   3h36m
dns-etcd          ClusterIP      10.103.39.133   <none>          2380/TCP,2379/TCP           4h14m
```
And then ask it to resolve google
```console
carlos@homelab:~$ $ dig @192.168.1.242 google.com
; <<>> DiG 9.10.6 <<>> @192.168.1.242 google.com
; (1 server found)
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 58380
;; flags: qr rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags: do; udp: 2048
;; QUESTION SECTION:
;google.com.			IN	A

;; ANSWER SECTION:
google.com.		30	IN	A	142.250.219.238

;; Query time: 130 msec
;; SERVER: 192.168.1.242#53(192.168.1.242)
;; WHEN: Sat Sep 25 19:25:11 -03 2021
;; MSG SIZE  rcvd: 65
```

As we see from the **answer** section, CoreDNS was able to resolve successfully!

## Adding external dns

This last piece was the easiest one. The tutorial has a sample manifest, all I had to do was change the namespace to the one I created, and the IP of `ETCD_URLS` to the one of my instance of `etcd` (the `yaml` bellow only differs on the IP address from the one in the tutorial, I'll still post it here as reference):

```yaml
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: external-dns
rules:
- apiGroups: [""]
  resources: ["services","endpoints","pods"]
  verbs: ["get","watch","list"]
- apiGroups: ["extensions","networking.k8s.io"]
  resources: ["ingresses"]
  verbs: ["get","watch","list"]
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: external-dns-viewer
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: external-dns
subjects:
- kind: ServiceAccount
  name: external-dns
  namespace: dnstools
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-dns
  namespace: dnstools
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-dns
  namespace: dnstools
spec:
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: external-dns
  template:
    metadata:
      labels:
        app: external-dns
    spec:
      serviceAccountName: external-dns
      containers:
      - name: external-dns
        image: k8s.gcr.io/external-dns/external-dns:v0.7.6
        args:
        - --source=ingress
        - --provider=coredns
        - --log-level=debug # debug only
        env:
        - name: ETCD_URLS
          value: http://10.103.39.133:2379
```

I kept the debug level log so we could see it in action using `kubectl logs` on the just created pod:

```
time="2021-09-25T22:28:00Z" level=debug msg="Endpoints generated from ingress: vmsm/vmsm-ingress: [vmsm.homelab.cadumillani.com.br 0 IN A  192.168.1.121 [] vmsm.homelab.cadumillani.com.br 0 IN A  192.168.1.121 []]"
```

We can see in the log above an entry being created for a simple service I created to turn my gaming VM on and off. You can read more about it [here]({% post_url 2021-08-07-integrating-kvm-apple-home %}) if you want.

And, of course, we can resolve it!

```console
carlos@homelab:~$ dig @192.168.1.242 vmsm.homelab.cadumillani.com.br

; <<>> DiG 9.10.6 <<>> @192.168.1.242 vmsm.homelab.cadumillani.com.br
; (1 server found)
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 14891
;; flags: qr aa rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags: do; udp: 2048
;; QUESTION SECTION:
;vmsm.homelab.cadumillani.com.br. IN	A

;; ANSWER SECTION:
vmsm.homelab.cadumillani.com.br. 30 IN	A	192.168.1.245

;; Query time: 57 msec
;; SERVER: 192.168.1.242#53(192.168.1.242)
;; WHEN: Sat Sep 25 19:33:31 -03 2021
;; MSG SIZE  rcvd: 107
```

# One thing left to study

For some reason `external-dns` keeps creating duplicates, and deleting them. Right after the log above I can see:

```
time="2021-09-25T22:28:00Z" level=debug msg="Removing duplicate endpoint vmsm.homelab.cadumillani.com.br 0 IN A  192.168.1.121 []"
```

That probably is related to the way the `CoreDNS` Provider is designed, and since it is in **alpha**, this could be a place to improve (maybe I'll adventure myself with that?).

# Conclusions 

Now, with one `deployment`, `service` and `ingress` resource for an application I can just apply it and access the application right away (given that I am using CoreDNS as the DNS server on my computer).

The ingress triggers both `cert-manager`, [that creates a valid certificate]({% post_url 2021-07-18-lets-encrypt-on-k8s %}), and `external-dns`, that generates an **A** DNS record on `CoreDNS`. Within a few seconds my new service is up and running, and can be accessed from any browser (well, im my case, any browser running in a computer in my LAN).