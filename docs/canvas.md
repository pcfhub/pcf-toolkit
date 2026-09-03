---
title: Canvas apps
description: Adding Link Toolkit to a canvas app or custom page.
order: 3
---
# In a canvas app

Both controls work in canvas. Add the code component to the app, bind
`LinkField`'s `value` to a text field or a variable, and `LinkColumn`'s
`records` to a table.

`navigation.openUrl` is available on every host, canvas included — it is the one
navigation method that is, which is why these controls use it and nothing else.

Two differences from a model-driven form, neither of them a fault in the control:

- **No column-level security.** Canvas publishes none, so LinkField treats the
  column as readable and editable and leaves permission to the app.
- **No host theme.** Canvas publishes no `fluentDesignLanguage`, so the controls
  take no position and their own light fallbacks apply. Absent is not the same as
  light, and a control that guessed from the operating system would render a dark
  field on a light app.
