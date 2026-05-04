# /flow Setup screenshots

Screenshots that appear next to each step on `/flow → Setup`.

Filename pattern (read by `app/flow/StepImage.tsx`):

```
{type}_step_{step}.png
```

served at the URL `/assets/{type}_step_{step}.png`.

## Expected files

### Step A · Create a group  (`type = group`)

| File                  | Step                                        |
|---                    |---                                          |
| `group_step_1.png`    | Open Groups blade → + New group             |
| `group_step_2.png`    | Group form: Security / name / Assigned      |
| `group_step_3.png`    | Members panel (skip — we add via Step B)    |
| `group_step_4.png`    | Click Create                                |
| `group_step_5.png`    | Overview → copy Object ID                   |
| `group_step_6.png`    | DEV: paste GUID into `.env.local`           |
| `group_step_7.png`    | DEV: restart dev server / re-run indexer    |

### Step B · Add a user  (`type = user`)

| File                  | Step                                        |
|---                    |---                                          |
| `user_step_1.png`     | Open Users blade → + New user → Create new  |
| `user_step_2.png`     | Basics tab (UPN / Display name / Password)  |
| `user_step_3.png`     | Properties tab (optional)                   |
| `user_step_4.png`     | Assignments → + Add group                   |
| `user_step_5.png`     | Review + create                             |
| `user_step_6.png`     | First-login note (myaccount.microsoft.com)  |

## Drop-in behaviour

- Any file format the browser supports (PNG, JPG, WebP, GIF) — but the URL
  path expected by `StepImage.tsx` ends in `.png`. Rename other formats to
  `.png` extension or update the component.
- Missing files render nothing — the surrounding step text still shows.
  Add screenshots one at a time without breaking the page.
- Click any thumbnail to open a full-size modal preview.
