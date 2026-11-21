---
name: avow-commitments
description: Use when an agent has to promise a business it may never have dealt with, such as reserving GPU capacity ahead or ordering a service from another business's agent, backed by money set aside for that one supplier, or when an agent receives such a commitment and has to check it before relying on it. Covers connecting to a business through Avow, staying inside the limits its person approved, booking, selling and buying a service between two agents, and checking a shared commitment on Tempo's testnet.
---

# Avow commitments

Avow lets an agent make a commitment for its business, which is a promise to one named supplier backed by money the business reserves in its own lock on Tempo. A supplier's agent checks the commitment against the chain without asking Avow, so two agents that have never met can rely on each other. Everything runs on Tempo's Moderato testnet with test dollars.

## When a commitment is the right tool

Reach for a commitment when the other side holds something for you ahead of time and wants to know you'll stand behind it. Reserving GPU capacity for a training run next week is the case it's built for. The supplier sees money set aside for it, the most it can charge for a no-show or a late cancellation, and when the reserve goes back.

A commitment is the wrong tool for paying as you go. When you pay for what you've already used, a payment does the job and nothing needs reserving. It's also the wrong tool for anything your person hasn't authorised, since every commitment has to fit limits they approved.

## Connecting

Use the `avow-sandbox` MCP server's tools, or the `avow-sandbox` command from a terminal. Both do the same thing.

1. Call `connect`, or run `npx avow-sandbox connect` in your project folder. Give the business ID only if your person gave you one. This makes your key, keeps it in `.avow` and asks for authority.
2. Send your person the link and the pairing code. They sign in with their passkey, check the console shows the same code, set your limits and approve. The link grants nothing by itself.
3. Call `status` to see once you're connected. Until then, the tools that commit refuse.

Your key stays in `.avow` on the machine that made it. Never print it, return it or send it to anyone, your person included.

## Committing

- `authority` says what you can commit right now: how much you can hold in bookings at once, what your key can still move today, and which suppliers you may book.
- `check` says whether a booking would pass, without booking or moving money. When it wouldn't, it names the reason code and the layer that would refuse.
- `book` makes the commitment and reserves the money in your business's lock. It answers with a link anyone can open to check it.
- `commitments` lists what you've made, each with its state on the lock and its link.

Send the link to the business on the other side, so it can check the reserve itself.

When Avow, the lock or the keychain refuses, tell your person the reason code and what the answer says would change it. Never work around a limit, split a booking to fit under one, or retry until something passes. A limit changes only when your person approves a new one.

## Selling and buying a service

Two agents can agree a service sold by the unit at a fixed price, such as a transcript or a design review, with the buyer's reserve standing behind what it owes if it cancels late or isn't there to take delivery.

To sell, your agent has to be connected to sell. No limit your person approved applies to what you sell, so the offer is the only bound on what you sign.

- `publish_offer` publishes an offer and answers with the offer itself. Ask your person for the price and both charges, and never choose them yourself. Hand the offer, whole, to the buyer's agent.
- `offers` lists what you've published.
- `orders` shows the orders waiting on you. `sell` quotes a new one, which signs your business's agreement to the terms the offer builds, and accepts one the buyer has funded.

To buy, call `order` with the offer the seller's agent gave you and a quantity. It checks the quote carries exactly the terms the offer builds, funds the commitment under your mandate and waits for the seller to accept. It answers with where the order stands, and calling it again with the order's id reads where it got to. Calling it with the offer again after an order has ended sends a new order, so use the id to ask about one you already sent.

The reserve backs the offer's two charges and nothing else. The price is paid separately, by the route the offer names, so never tell anyone the reserve pays for the service. An order names the offer's price, so there is nothing to negotiate inside one. A different price is a new offer from the seller.

## Checking a commitment someone sent you

Before you rely on a commitment another agent sent, call `verify` with its link and your payout address as `payee`, or run `npx avow-sandbox verify <link> --payee <address>`. It needs no connection. It reads the lock through the factory the SDK trusts, and it says whether the chain backs the commitment, how much the lock holds, where the commitment stands, who it pays, and when free cancellation ends and the reserve releases.

Rely on it only when it stands and pays you. The terms come from the buyer, and the link's terms hash is what ties them to the reserve.

## Words

Say reserve, commitment, charge, dispute and release. A commitment isn't insurance, a bond, coverage or a guarantee, and Avow never holds the money or an agent's key.
