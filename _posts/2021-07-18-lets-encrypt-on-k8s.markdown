---
layout: post
title:  "setting up Let's Encrypt on my private kuberntes cluster"
date:   2021-07-18 19:07:00 -0300
categories: personal
---

I've been using self signed certificates for a while, but safari started complaining about them with no simple option to simply trust the certificated as I had before. So, I decided to work on something I've been postponing for a while: using let's encrypt to generate trusted certificates.

With an instance of [cert-manager](https://cert-manager.io/docs/) running, things were pretty straight-forward. With some annotations on the [ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/) definition, and some configurations about how _cert-manager_ should generate the certificate, everything - generating, renewing ans using certificates - is done automatically.

For my cluster, I'm using an [Nginx Ingress Controller](https://kubernetes.github.io/ingress-nginx/), but I found no restriction about the chosen controller, so others should work too.

# Cert-Manager resources

Cert manager supports a bunch of different strategies to issue certificates. Before, I was using the [self signed](https://cert-manager.io/docs/configuration/selfsigned/), my goal now was to implement [ACME](https://cert-manager.io/docs/configuration/acme/). 

_ACME_ is a protocol provides a way to automate certificate generation, given a challenge can be fulfilled. There are currently two kinds of challenge: 
* HTTP01 - Where to prove that you own the subdomain you should be able to serve a certain file from your server
* DNS01 - Here a TXT record is created in your DNS server

Let's Encrypt and Cart-Manager both have good documentation on ACME and its challenges, so let's focus on the implementation.

The HTTP challenge would not be possible, since my servers are not exposed and thus Let's Encrypt servers would not be able to reach them to verify the file, so we needed to use the DNS one. [There is a page](https://cert-manager.io/docs/configuration/acme/dns01/#supported-dns01-providers) with supported DNS providers, anything outside that list does not mean it would be impossible, but it would require more work, for example, using a [webhook](https://cert-manager.io/docs/configuration/acme/dns01/#supported-dns01-providers).

I choose to migrate my DNS to cloudflare since it is free and supported (note, I have no association with them), so I just needed to create two resources:
* A `Secret` to hold my _API-TOKEN_
* A `ClusterIssuer` to listen to requests and generate certificates to my ingresses

Since I want every namespace to be able to issue a certificate, I used a `ClusterIssuer`, not just an `Issuer`.

{% highlight yaml %}
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token-secret
type: Opaque
stringData:
  api-token: <Your-Token>
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: cloudflare-letsencrypt-issuer
spec:
  acme:
    email: <your-mail@example.com>
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      # Secret resource that will be used to store the account's private key.
      name: cloudflare-letsencrypt-issuer-account-key
    solvers:
    - dns01:
        cloudflare:
          email: <your-mail@example.com>
          apiTokenSecretRef:
            # Name of the secret created on the other resource
            name: cloudflare-api-token-secret
            key: api-token
{% endhighlight %}

The resources above needs _Cert Manager_ to be configured already, and once applied we can move to the next step, that is telling our ingress to use this new `ClusterIssuer`.

# Ingress Resource

I'll give here the example of how my grafana ingress came out, commenting above the important lines.

{% highlight yaml %}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    # Tells Cert Manager to generate a certificate using our configured ClusterIssuer
    cert-manager.io/cluster-issuer: cloudflare-letsencrypt-issuer
    nginx.ingress.kubernetes.io/auth-realm: Authentication Required
    nginx.ingress.kubernetes.io/auth-secret: basic-auth
    nginx.ingress.kubernetes.io/auth-type: basic
  name: grafana
  namespace: monitoring
spec:
  rules:
  - host: grafana.homelab.cadumillani.com.br
    http:
      paths:
      - backend:
          service:
            name: grafana
            port:
              name: http
        path: /
        pathType: Prefix
  tls:
  - hosts:
    - grafana.homelab.cadumillani.com.br
    # Secret that Cert Manager will create with certificate
    secretName: homelab-grafana-ingress-le-cert
{% endhighlight %}

Basically, using the `cert-manager.io/cluster-issuer` annotation we tell Cert Manager that we want it to use the given `ClusterIssuer` to issue a certificate, and it uses the `tls` section of the _yaml_ to know which domain to issue to certificate to, and where to store it after it's generated.

# Conclusion

I was expecting the configuration of the DNS01 challenge to give me much more trouble, I'm really impressed of how smooth that went, given _Cert Manager_ and an _Ingress Controller_ already configured.

It is a challenge to administrate a kubernetes cluster, and there is a long way before I can say comfortably that I know how to do that, but this kind of integration makes the effort seems kinda worth it!

![Trusted Certificate on grafana](/assets/lets-encrypt-on-k8s/encrypted-grafana.png)