# Reverse proxies and the client's IP address

Why sign-in (Better Auth, ADR-055) needs the real IP address of each person, how a reverse proxy hides it, and what
each deployment has to configure. Written 2026-10-09 (Gary asked); the settings are in `auth/src/config.ts`.

## What a reverse proxy is

It's a server in front of your app. Browsers never talk to the app directly; they talk to the proxy, which passes
each request on.

```
Browser ──► Reverse proxy ──► our containers (web app, API, sign-in)
            (nginx, a load balancer, CloudFront, a corporate gateway)
```

Almost every real deployment has one, or several:
- **One public address and certificate:** HTTPS ends at the proxy, so the containers behind it stay private.
- **Routing:** `/api/auth` goes to the sign-in service, and everything else to the web app.
- **Spreading load** across several copies of a container.
- **Security filtering**, such as a web application firewall.

## The side effect: the app loses the person's address

When the proxy passes a request on, the connection the app sees comes from the proxy, not the browser. Every
request appears to come from one address.

To fix that, proxies add a header naming the original caller:

```
X-Forwarded-For: 203.0.113.7
```

With several proxies, each one adds to the list, so the app gets a chain:

```
X-Forwarded-For: 203.0.113.7, 10.0.0.5        (the person, then the first proxy)
```

## Why the address matters to us

Better Auth uses it for two things:

- **Rate limits:** so many attempts per address, to stop password guessing. If every request looks like the proxy's,
  everyone shares one limit. Then one attacker's guesses lock everyone out, or the limit is so loose it protects
  nothing.
- **Sessions:** it records where each sign-in came from.

## The catch: anyone can write that header

`X-Forwarded-For` is just text in the request, so an attacker can send their own:

```
X-Forwarded-For: 1.2.3.4          ← made up, and different on every request
```

That would dodge the rate limit by looking like a new person each time. A proxy doesn't remove a header the caller
sent; it adds the real address to the end. So the chain arrives like this:

```
X-Forwarded-For: 1.2.3.4, 203.0.113.7, 10.0.0.5
                 (fake)   (real person) (our proxy)
```

**Only the entries your own proxies added can be believed.** The safe way to read the chain:

1. Start from the right.
2. Skip every address that is one of your proxies.
3. The first address that isn't yours is the real person.

To do that, the app has to know which addresses are its proxies: that's `trustedProxies`.

## What Better Auth does

- **A header with a single address:** it trusts that address as it is.
- **A chain:** it reads it only for proxies named in `advanced.ipAddress.trustedProxies` (our `AUTH_TRUSTED_PROXIES`).
- **Neither:** every request shares one rate-limit bucket, and it logs "Rate limiting could not determine a client
  IP…".

## Our three situations

### 1. Locally and in CI: nothing to do

```
Browser ──► Vite (port 5173) ──► sign-in service (port 3001)
```

Vite is the only proxy, and it sends a single address (`xfwd` in `web/vite.config.ts`), which Better Auth trusts as
it is.

### 2. On-premises: the customer's network decides

```
Browser ──► customer's load balancer ──► customer's nginx ──► our containers
```

We don't control their proxies, so the install needs one of two set-ups.

- **A. List their proxies:** `AUTH_TRUSTED_PROXIES=10.20.0.4,10.20.0.5` (the load balancer's and nginx's
  addresses). Better Auth then reads the chain.
- **B. Their last proxy replaces the header instead of adding to it:** it sends only the address it saw, for
  example with nginx's `proxy_set_header X-Forwarded-For $remote_addr;`. Better Auth then gets a single address and
  needs no list.

**The on-premises trap: list exact proxy addresses, never a broad private range like `10.0.0.0/8`.** An in-house
customer's staff are often on that same private network. Trusting the whole range trusts the people as well as the
proxies, and someone inside could fake their address again.

**Either way, our containers must be reachable only through their proxy.** Anyone who can reach the sign-in service
directly can write any header they like.

### 3. Our cloud: CloudFront writes one trusted header

```
Browser ──► CloudFront ──► (load balancer) ──► our containers
```

CloudFront runs on thousands of AWS addresses that change, so listing them as trusted proxies isn't practical.

- **A small CloudFront Function sets `x-client-ip`** to the address CloudFront saw, replacing anything the caller
  sent. That's the single trusted address `DEPLOYMENT=cloud` expects by default.
- **The containers accept traffic only from CloudFront** (security groups, plus a secret header CloudFront adds),
  so nobody can go around it and write the header themselves.

## What we have to do, and when

| Where | What | When |
|---|---|---|
| Locally and in CI | nothing: it already works | done (ADR-055 phase A) |
| Our cloud | the CloudFront Function for `x-client-ip`, and the containers locked to CloudFront | PLAN 14.8 |
| On-premises | the install guide asks for the proxy addresses (`AUTH_TRUSTED_PROXIES`), or gives the header-replacing proxy setting; our containers stay behind their proxy | the on-premises package (PLAN 14.8) |

**A check after any install:**
1. Sign in from two different machines and confirm they're counted separately.
2. Make sure Better Auth's "could not determine a client IP" warning isn't in the logs; if it is, the set-up is
   wrong.
