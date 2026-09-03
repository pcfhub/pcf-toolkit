---
title: Overview
description: What Link Toolkit does, and when to reach for it.
order: 1
---
# Link Toolkit

Render a URL column as a real link — on a form, and in every row of a view.

A Dataverse text column holding a web address is one of the most common things on
a form and one of the least useful: the platform renders it as text, so following
it means selecting, copying and pasting. This solution installs **two controls**
that fix that in the two places it matters.

| Control | Bind it to | What it does |
| --- | --- | --- |
| `PCFHub.LinkField` | a single column | Shows the address as a link, opens it through the platform, and keeps an unsaved edit across a form tab switch |
| `PCFHub.LinkColumn` | a view or subgrid | The same rule per row: a cell holding a followable address becomes a link, everything else stays text |

:::callout{type=info}
Both controls arrive in the same managed solution and can be used independently.
The demo and the API reference on this page describe **LinkField**; PCFHub
publishes one component per repository, and LinkColumn ships alongside it.
:::

## Why this one

- **Links open through the platform, never through an `href`.** The anchor keeps
  a real `href` so it behaves like a link — hover preview, copy link address,
  open in a new tab — but an ordinary click is routed through
  `navigation.openUrl`. That is what works inside a canvas app, inside the mobile
  shell, and inside the iframe a model-driven form is, where an unprevented click
  navigates the *form* and loses whatever was being edited.
- **A stored URL is treated as untrusted.** Only `http` and `https` are ever
  followable. See [Limitations](limitations) for what that refuses and why.
- **An unsaved edit survives a tab switch.** Moving to another tab and back
  destroys a code component and creates a new one. LinkField hands its in-flight
  edit to the platform and reads it back, so the address you were half-way
  through typing is still there.

## What it works with

Model-driven forms, canvas apps and custom pages. Neither control declares a
single `<uses-feature>`, so **installing this solution asks the maker for no
permissions at all**, and neither reaches an external service itself — they ask
the platform to open a link, which keeps the component out of premium licensing.

Power Pages is untested.
