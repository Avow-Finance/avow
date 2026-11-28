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
- `check` says whether a booking would pass, without booking or moving money. When it wouldn't, it names the reason code and the layer that would refuse. Give it an offer and a quantity to check an order for a service the same way.
- `book` makes the commitment and reserves the money in your business's lock. It answers with a link anyone can open to check it.
- `commitments` lists what you've made, each with its state on the lock and its link.
- `commitment_events` reads what your business's lock logged for one of those commitments, from the chain's final blocks: the reserve, the acceptance, each charge and the release. It reads the lock and never Avow. An event is a notice that grants nothing and proves nothing on its own, so check the commitment with `verify` before you act on one. When it says the read stopped short, call it again from the block it names for later ones.
- `top_up` asks the sandbox faucet for more test dollars when your business runs low. They go to the business's account, never its lock, so your limits stay the same. A business gets one a day.

Send the link to the business on the other side, so it can check the reserve itself.

When Avow, the lock or the keychain refuses, tell your person the reason code and what the answer says would change it. Never work around a limit, split a booking to fit under one, or retry until something passes. A limit changes only when your person approves a new one.

- `request_change` asks your business for a change when a booking needs it: a higher limit, a supplier named on the lock and in your mandate, or the lock opened to suppliers the testnet registry lists up to a cap. It answers with a link for your person, where the administrator approves or declines with their passkey. Ask once, for what the booking needs, and send the link.
- `request_seller_mandate` asks your business for a seller's mandate, the limits on what your agent may sell. Ask your person for every limit and never choose them yourself. It answers with a link for your person, or says Avow doesn't take these requests yet, and then nothing was asked.
- `request_status` says where that request stands. Keep within your current limits until it says the request is active, since approved isn't usable until the change lands.

## Selling and buying a service

Two agents can agree a service sold by the unit at a fixed price, such as a transcript or a design review, with the buyer's reserve standing behind what it owes if it cancels late or isn't there to take delivery.

To sell, your agent has to be connected to sell. No limit your person approved applies to what you sell, so the offer is the only bound on what you sign.

- `publish_offer` publishes an offer and answers with the offer itself. Ask your person for the price and both charges, and never choose them yourself. Hand the offer, whole, to the buyer's agent.
- `offers` lists what you've published.
- `list_offer` lists an offer you published with Avow, which checks it against your newest seller's mandate first and lists nothing the mandate doesn't allow. An item has one current listing, so listing a new version replaces the old one. `withdraw_listing` takes an item's listing away. Avow never lists a version again once it's replaced or withdrawn, so publish a new one instead. When Avow holds no seller's mandates it lists nothing and says so. A listing grants nothing.
- `orders` shows the orders waiting on you. `sell` quotes a new one, which signs your business's agreement to the terms the offer builds, and accepts one the buyer has funded. An order it won't quote it declines, so the buyer hears why. A refusal by your seller's mandate reaches the buyer only as `supplier.not_authorized`, since your limits are your own.
- `decline` turns an order away for a reason of your own, with a reason code from its list and only the fields that reason takes. Never write the buyer a note, since a decline carries none.

To buy before any business has given you an offer, call `test_sellers`. It lists Avow's test sellers, labelled test businesses that sell simple services at any hour, each with its offers. Nothing they sell is delivered or billed, and none is verified, so call each one a test business. When the sandbox lists none, it says so.

To buy, call `check` with the offer the seller's agent gave you, or one `test_sellers` listed, and a quantity, then `order` with the same two once it would pass. `check` gives the price beside the reserve. Your limits count the reserve and not the price, so weigh the price against what your person asked for. It checks the quote carries exactly the terms the offer builds, funds the commitment under your mandate and waits for the seller to accept. It answers with where the order stands, and calling it again with the order's id reads where it got to. Calling it with the offer again after an order has ended sends a new order, so use the id to ask about one you already sent.

When an order comes back declined, act on its reason code and next step. Ask again after the time it suggests, send a different order, or look for another seller. Never send the same order again unchanged and at once. When it names a replacing version, check that version as a new offer, with `check`, before ordering it, since its price and rules can differ. `withdraw_order` takes back an order your business sent, before it's funded, so the seller stops working on it. Any active agent of the business can withdraw one, so an order outlives the agent that sent it. `thread` reads a thread order and replays its moves before saying where it stands. Act on nothing from a thread that doesn't replay.

The reserve backs the offer's two charges and nothing else. The price is paid separately, by the route the offer names, so never tell anyone the reserve pays for the service. An order names the offer's price, so there is nothing to negotiate inside one. A different price is a new offer from the seller.

## Checking a commitment someone sent you

Before you rely on a commitment another agent sent, call `verify` with its link and your payout address as `payee`, or run `npx avow-sandbox verify <link> --payee <address>`. It needs no connection. It reads the lock through the factories the SDK trusts, and it says whether the chain backs the commitment, how much the lock holds, where the commitment stands, who it pays, and when free cancellation ends and the reserve releases.

Rely on it only when it stands and pays you. The terms come from the buyer, and the link's terms hash is what ties them to the reserve.

## Words

Say reserve, commitment, charge, dispute and release. A commitment isn't insurance, a bond, coverage or a guarantee, and Avow never holds the money or an agent's key.
