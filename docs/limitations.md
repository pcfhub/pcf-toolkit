---
title: Limitations
description: What Link Toolkit does not do.
order: 7
---
# Limitations

## Only `http` and `https` links are followable

Anything else renders as plain text rather than as a link. That includes
`mailto:`, `tel:`, `file:` and relative paths such as `/main.aspx?etn=account`.

This is deliberate and it is a security boundary rather than an oversight.
`navigation.openUrl` hands the string to the host, and a host that resolves
`javascript:` executes it **in the app's own origin** — so a text column that
anybody with write access can edit would otherwise become a way to run script in
every other user's session. The rule is an allow-list of two schemes, because a
block-list is only ever as long as its author's imagination: `javascript:` is the
one everybody thinks of, and `data:` and `vbscript:` reach the same place.

Relative paths falling out as refused is a real cost of that choice. Resolving
one needs a base URL the control has no reliable way to obtain, and guessing
wrong inside a model-driven form resolves against the *form's* address.

## A blank column is not a link

A cleared column is written back as no value rather than as an empty string, so
"no link" and "a link that is blank" stay different things.

## Keeping an unsaved edit depends on the host

LinkField asks the platform to hold its in-flight edit with
`mode.setControlState`. The platform returns `false` when it has nowhere to put
it. The control does not pretend otherwise — it says the edit will not be kept
rather than implying it is safe.

## LinkColumn is not separately listed on the hub

PCFHub publishes one component per repository. LinkColumn is installed by this
solution and works independently, but the demo and the API reference on this
component's page describe LinkField.

## LinkColumn shows the site name, not the formatted value

A URL column's formatted value is the address itself, which in a grid is mostly
query string. Cells show the host without `www.` instead, matching what LinkField
shows on a form. There is no per-row label.
