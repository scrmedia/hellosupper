# Using HelloSupper with an AI agent

You don't need an AI agent. Everything on the board works by tapping. An agent is handy for the fiddly bits: typing in a recipe from a photo, telling the board you're away on Thursday, or turning the shopping list into an online order.

## What an agent can do

The project includes a small command-line tool, `scripts/board.mjs`. An agent runs it the same way you would, and reads what it prints.

| Command | What it does |
|---|---|
| `node scripts/board.mjs status` | This week's votes, the likely winners, and what's locked in |
| `node scripts/board.mjs shopping` | This week's shopping list as plain text |
| `node scripts/board.mjs add-recipe recipe.json` | Adds a recipe to the library (or updates it) |
| `node scripts/board.mjs recipes` | Lists recipes added on the board or by an agent |
| `node scripts/board.mjs remove-recipe <id>` | Removes one |
| `node scripts/board.mjs set-week --dinners 3 --note "Away Thursday and Friday"` | Suggests the week's number of dinners, nights and a note |
| `node scripts/board.mjs dislikes` | Who said "not for us" to what, and why |

Add `--json` to any of them for output that's easier for a program to read, and `--week 2026-01-05` (a Monday) for a week other than this one.

The tool needs two settings: your board's address and its password. Set them in the terminal, or give them to your agent to keep:

```sh
export SB_URL=https://our-dinners.pages.dev
export SB_PASSWORD="your board password"
```

On Windows PowerShell, use `$env:SB_URL = "https://our-dinners.pages.dev"` and `$env:SB_PASSWORD = "your board password"`.

The tool only reads and writes the board. It can't buy anything or talk to any shop.

### The recipe format

When an agent adds a recipe, it writes a small file like this and runs `add-recipe`:

```json
{
  "id": "custom-chilli-con-carne",
  "title": "Chilli con carne",
  "timeMins": 45,
  "servings": 2,
  "cuisine": "Mexican",
  "ingredients": ["250g beef mince", "1 red onion", "1 tin kidney beans", "1 tin chopped tomatoes"],
  "steps": ["Fry the onion until soft.", "Add the mince and brown it.", "Add the beans and tomatoes and simmer for 20 minutes."],
  "categories": ["slow-cooker"],
  "sourceUrl": "https://example.com/where-it-came-from",
  "image": "https://example.com/photo.jpg"
}
```

- `id` starts with `custom-` for your own recipes and `web-` for ones from a website. Using the same id again updates the recipe.
- Ingredients can be plain lines (`"250g beef mince"`) or objects (`{"name": "beef mince", "qty": 250, "unit": "g"}`).
- Keep the steps separate. Safari's cooking view shows one step per screen.
- `categories`, `image` and `sourceUrl` are optional. Categories are worked out automatically. Only add ones it can't spot, such as `slow-cooker`.

The tool tells you which categories the recipe landed in and whether anything is missing for the recipe page.

## With OpenClaw

[OpenClaw](https://docs.openclaw.ai) is a personal AI assistant that runs on your own computer and that you can message from your phone. It can run commands and use a web browser for you.

1. Install OpenClaw by following its [documentation](https://docs.openclaw.ai).
2. Put your HelloSupper folder somewhere OpenClaw can reach, such as inside its workspace folder.
3. Tell it, once: *"My meal-planning board is in the hellosupper folder. Read README.md and docs/AI-AGENTS.md. The board is at https://our-dinners.pages.dev and the password is ... Keep the password somewhere safe, not in the project folder."*
4. Then just ask, from wherever you message it:
   - *"What did we vote for this week?"*
   - *"Add this to HelloSupper"* and send a link, a screenshot of a recipe, or a photo of a cookbook page.
   - *"We're out on Wednesday, so three dinners this week."*
   - *"Send me this week's shopping list."*

OpenClaw can also do your online shop in your browser. See "Optional: how one household does its online shop" in the [README](../README.md#optional-how-one-household-does-its-online-shop). Always check the basket and pay yourself.

## With Claude Code

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) is an AI assistant that works in a terminal, inside a project folder.

1. Install it by following its documentation.
2. Open a terminal in your HelloSupper folder, set `SB_URL` and `SB_PASSWORD` as above, and type `claude`.
3. Ask in plain English:
   - *"Help me set this up. Follow docs/SETUP.md."*
   - *"Add this recipe to the board: <paste the recipe>"*
   - *"Change the rules so it never suggests fish, then redeploy."*
   - *"Print this week's shopping list."*

Claude Code can also change the board itself, for example a new colour scheme or a new tab. Run the checks afterwards (`node scripts/check-site.mjs http://localhost:8788/ --password letmein` while `npm run dev` is running).

## With any other agent

Any agent that can run terminal commands can use `scripts/board.mjs`. Point it at this file and give it the address and password.

An agent that can't run commands can still help. Paste in the shopping list (Shopping, then **Copy list**), or ask it to write a recipe out with one ingredient per line and one step per line, then paste that into **+ Add a recipe** on the board.

## Without an agent

Use the board as it is. Vote, lock in, shop from the list and cook from the recipe. Add recipes with **+ Add a recipe**, by typing them in or from a link.
