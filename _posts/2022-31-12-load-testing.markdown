---
layout: post
title:  "horizontal scaling on kubernetes is not as simple as you think"
date:   2023-01-01 19:05:00 -0300
categories: cloud
tags: ["scaling", "hpa", "kubernetes", "rps"]
layout: math_post
---

When you increase the number of replicas of a `deployment` in Kubernetes and end up with fewer requests per second (more on that [later](#scaling-up-to-achieve-lower-througput)) on your load test something is wrong. With this scenario, I started studying and testing web servers' performance and I wanted to write a little about it, how to know when to scale and what to fix to improve performance.

## Forget web servers, you manage a supermarket

Before diving into servers, let's look into an analogy. 
You are tasked with reducing checkout time in a supermarket you manage. What do you do?

### Throughput, queue and latency

We may breakdown checkout time of a customer ($$C_t$$) into queue time ($$Q_t$$) and register time ($$R_t$$):

$$C_t = Q_t + R_t$$

We may reduce $$Q_t$$ by adding more registers, but only up to a point where there is no more queue. To increase throughput after that we need to reduce $$R_t$$. 

It is possible to break down $$R_t$$ by the time spent on each activity: weighting vegetables ($$w_t$$), scanning barcodes ($$s_t$$) or receiving payment ($$p_t$$):

$$ R_t = w_t + s_t + p_t $$

Once you measure these times you can _pareto_ your improvements by focusing on the most expressive times. 

If after measuring 100 customers you see that a big percentage of the checkout time was spent weighting you can get a faster scale, or maybe put the scale before the cashier so that customers without anything to weigh will not be penalized. 

Another thing you may look into is concurrency. Let's say that one credit card terminal is shared between many registers. You may increase the number of registers, but if you don't increase the number of credit card terminals some customers may have to wait before the resource is available and only then complete the checkout. In this scenario, $$p_t$$ is a function of the number of credit card terminals ($$t_c$$) and the payment method ($$p_m$$):

$$ p_t = f(t_c, p_m) $$

Summing it all up, for our simple checkout example we would have:

$$C_t = Q_t + w_t + s_t + p_t(t_c, p_m)$$

It is possible to go beyond: what if we want to reduce the total time a customer spends in the supermarket? This goes from parking to shopping, checking out and finally exiting the parking lot. Oh boy, and the complexity does not need to stop here: 
* do our customers use motorcycles or cars?
* do we have a paid parking lot or no parking lot at all?
* and so on...

## Back to servers

Adding more registers is horizontal scaling, and checkout time is our response time. Both may increase throughput, but depending on our architecture and the number of clients, improving each one will only increase our requests per second up to a point.

That is why measuring your times, profiling your application, and knowing your client are the most important parts when optimizing a service. With all that data you will know what is needed, and you will be able to get feedback.

Some problems may arise from other parts of your system, like DNS, TLS or Load Balancer, but those software are usually much more battle-tested than your "fresh from the oven" web app.

### Scaling up to achieve lower throughput

So, this is the reason why I am writing this post, and what I wrote above took me a while to click. It all began when we had a web app that was performing very badly (less than 10rps[^rps]). We use [Datadog](https://www.datadoghq.com/) at work, so we went to see the traces and there was a simple mistake: public keys used to verify JWT were not cached. Another issue was our [gunicorn](https://gunicorn.org/) `worker-class`: the [default is `sync`](https://docs.gunicorn.org/en/stable/design.html#sync-workers), which means each worker can only process one request at a time, and simply adding a `--threads` parameters improved our scenario. 

Those changes got us to around 20 requests per second without scaling the service but in increased load scenarios some requests were failing. We increased the number of pods in the `replicaset` and that problem was solved, but the rps was still around 20, and that intrigued me.

For our scenario, it was probably our small development database acting as the bottleneck (concurrency), but out of curiosity I spun up a [simple go app](https://github.com/cmillani/docker-x-ray/tree/fae5178ce7db91873f2612e688fa2604a07c79a7/go) on my toy cluster and ran some load tests while changing the number of replicas. To my surprise, the first time I scaled the application the throughput went down.


[^rps]: rps = requests per second

### Stress tests

> I'll keep the scripts in a collapsible tag since they are not the focus here.

> Also, on the [next session](#summarizing-tests-results) there are the test results summarized!

To simulate load I used [K6](https://k6.io/), and for my first test, I simply hit the `/health` endpoint. Let's see the test summary with 1 replica:

{::options parse_block_html="true" /}

<details><summary markdown="span">The k6 script</summary>
```js
import http from 'k6/http';

import { check, sleep } from 'k6';

export const options = {
  vus: 30,
  duration: '60s',
};

export default function () {
  const res = http.get('http://stresstest.example.com/health');
  check(res, { 'status was 200': (r) => r.status == 200 });
}
```
</details>

<details><summary markdown="span">Kubernetes resources</summary>
> note that I'm specifying the pod to run on `node01`

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: stresstest
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  namespace: stresstest
  name: stresstest
  labels:
    app: stresstest
spec:
  rules:
  - host: stresstest.example.com
    http:
      paths:
      - backend:
          service:
            name: stresstest
            port:
              number: 80
        path: /
        pathType: Prefix
---
apiVersion: v1
kind: Service
metadata:
  name: stresstest
  namespace: stresstest
  labels:
    app: stresstest
spec:
  selector:
    app: stresstest
  ports:
    - protocol: TCP
      port: 80
      targetPort: 8899
  type: ClusterIP
---
apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: stresstest
  name: stresstest
  labels:
    app: stresstest
spec:
  selector:
    matchLabels:
      app: stresstest
  strategy:
    type: Recreate
  replicas: 1
  template:
    metadata:
      labels:
        app: stresstest
    spec:
      nodeName: node01
      containers:
      - name: stresstest
        image: cmillani/go-distroless-sample
        resources:
          requests:
            memory: "50Mi"
            cpu: "50m"
        ports:
        - containerPort: 8899
          name: stresstest
```
</details>

<details><summary markdown="span">Web server details</summary>
> I manually configured the DNS `stresstest.example.com` to point to my ingress controller, and the hostname on the response is just to return something other than an "OK"

```console
cadumillani@homelab:~$ kubectl get pods -o wide
NAME                          READY   STATUS    RESTARTS   AGE   IP           NODE     NOMINATED NODE   READINESS GATES
stresstest-7ff8f65cf5-fsmmg   1/1     Running   0          96s   10.36.0.38   node01   <none>           <none>
cadumillani@homelab:~$ curl http://stresstest.example.com/health
{"status":true,"hostname":"stresstest-7ff8f65cf5-fsmmg"}
```
</details>
<br/>

{::options parse_block_html="false" /}

Let's take a look at the output of the `k6 run`, focusing on latency and throughput:
> k6s also gives us more details to help troubleshoot what could be a gateway (connection) or tls problem, but I'll focus on those two metrics

```
http_reqs......................: 139362  2308.777135/s
iteration_duration.............: avg=12.92ms  min=2.26ms med=7.94ms max=1.22s    p(90)=16.16ms p(95)=22.54ms
```

Now, let's change the Kubernetes file a little, removing the node selector and adding an anti-affinity so that we have one pod on every 
```diff
61c61,70
<       nodeName: node01
---
>       affinity:
>         podAntiAffinity:
>           requiredDuringSchedulingIgnoredDuringExecution:
>           - labelSelector:
>               matchExpressions:
>               - key: app
>                 operator: In
>                 values:
>                 - stresstest
>             topologyKey: "kubernetes.io/hostname"
```
and now scale:
```sh
kubectl scale deployment stresstest --replicas 2
```
```console
cadumillani@homelab:~$ k get pods -o wide
NAME                         READY   STATUS    RESTARTS   AGE   IP           NODE     NOMINATED NODE   READINESS GATES
stresstest-bddbf9ddb-6fm6r   1/1     Running   0          51s   10.44.0.22   node02   <none>           <none>
stresstest-bddbf9ddb-8lfdx   1/1     Running   0          82s   10.36.0.38   node01   <none>           <none>
```

And test again:
```
http_req_waiting...............: avg=14.22ms  min=2.35ms med=8.63ms max=662.13ms p(90)=18.36ms  p(95)=28.57ms
http_reqs......................: 122858  2047.131356/s
```

Well, one more pod and 300 fewer rps (on this test). 

One important bit: `node02` is a VM on an old notebook from 2012 and `node01` is a VM on a much newer Ryzen 5 3500. Higher latency is expected on `node02`, and since the request volume is probably not high enough to queue, I simply added a slower server to balance a load that did not require balancing, resulting in a worse throughput. If I increased the VUs I would expect better numbers.
Another issue is that I'm not limiting CPU, and I'm not sure that all CPU from `node01` is being used. To tackle both issues I'll limit the CPU to the same amount as the requests, and make both replicas run on `node01`:

Now let´s repeat with 1 replica on `node01`:

```
http_reqs......................: 38205   636.677855/s
iteration_duration.............: avg=47.08ms  min=2.82ms med=13.75ms max=1.26s    p(90)=122.47ms p(95)=167.36ms
```

And with 2 replicas on `node01`:
```
http_reqs......................: 65690   1092.053625/s
iteration_duration.............: avg=27.4ms   min=2.43ms med=9.8ms  max=1.07s    p(90)=74.2ms  p(95)=124.85ms
```

I also did some tests changing the CPU limitations, and the number of VUs, the details are in the next session!

### Summarizing tests results
Summarizing, all (unless specified) tests running for 60 seconds with 30 VUs, across both or a single node, with one or two replicas:

#### No CPU limits

|replicas|affinity   |rps   |p(95)   |
|-|-|-|-|
|1       |node01     |2308.8|22.54ms |
|2       |node01     |2261.6|22.74ms |
|2       |distributed|2047.1|28.57ms |

#### Limited 10 Millicores

|replicas|affinity   |rps   |p(95)   |
|-|-|-|-|
|1       |node01     |190.68|306.13ms|
|2       |distributed|115.45|897.97ms|

#### Limited 50 Millicores

|replicas|affinity   |rps   |p(95)   |
|-|-|-|-|
|1       |node01     |636.68|122.47ms|
|2       |node01     |1092.1|74.2ms  |

#### Increased VUs
Looking into those numbers it seems that if we can tolerate higher latency it should be possible to increase the throughput! Let's raise the bar! For this test, I'll use a single replica on `node01` limited to 100 Millicores, all tests running for 60 seconds.

|VUs |rps   |p(95)   |
|-|-|-|
|1   |128.86|9.67ms  |
|10  |983.65|25.08ms |
|100 |1539.6|174.03ms|
|1000|2316.3|1.16s   |

> Note: those tests were executed from a single machine, so we may get different results if we run the big ones in a distributed manner.

## Conclusion

In this text, I compared web servers with supermarkets and requests with a checkout. Sometimes there are queues and adding more registers won't always make things faster.

When you think you need to scale your servers profile your requests and make sure that your bottleneck is your server and not any external dependency. 

Another important point is: don't scale for the sake of better numbers but instead define a goal (users and latency). As I showed in the tests above it is possible to achieve a high throughput (number of users) while sacrificing latency a bit (and better utilizing your resources).

Finally, if you need to scale, first take a look at all your processes' flame graphs and see if there is any hanging fruit. Sometimes [a simple cache makes the difference between 87 and 34k rps](https://fasterthanli.me/articles/i-won-free-load-testing).

---




