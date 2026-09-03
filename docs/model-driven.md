---
title: Model-driven apps
description: Adding Link Toolkit to a form.
order: 4
---
# On a model-driven form

**LinkField** — open the form in the maker portal, select the field bound to your
URL column, and add `PCFHub.LinkField` under Components. Bind `value` to the
column. `linkLabel` is optional; left empty the control shows the site name.

**LinkColumn** — set it as the control for a view or a subgrid and bind
`records`. It renders whatever columns the view supplies and decides per cell
whether the value is followable, so no column has to be nominated as "the URL
one".

Two things worth knowing here specifically:

- **The tab switch is a full teardown.** Moving to another form tab and back
  destroys the control and creates a new one. LinkField is written for that; a
  half-typed address survives it.
- **Column-level security is honoured.** A column the user cannot read shows a
  message saying so rather than an empty field, which is a different thing and
  looks identical without it.
