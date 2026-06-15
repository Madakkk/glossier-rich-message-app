# Glossier Rich Message App v5

This app receives a product query from a Text skill, fetches Glossier products, matches products, adds an agent to the chat, and sends a rich message carousel.

## Render settings

Build command:

```bash
npm install && npm run build
```

Start command:

```bash
npm start
```

## Environment variables

Use either token variable. `TEXT_ACCESS_TOKEN` is preferred.

```env
TEXT_ACCESS_TOKEN=your_token
# or
TEXT_API_TOKEN=your_token

TEXT_TARGET_AGENT_ID=m.kosnik+wecandoit@text.com
```

If your token already includes `Basic ` or `Bearer `, the app will keep it. If not, the app sends it as `Basic <token>`.

## Endpoints

Health check:

```txt
GET /health
```

Environment debug, does not expose token:

```txt
GET /debug-env
```

Webhook:

```txt
POST /webhook/glossier-products
```

Body:

```json
{
  "chat_id": "TG1OEGS4Y1",
  "query": "I'm looking for a blush"
}
```

## Flow

1. Fetches `https://www.glossier.com/products.json?limit=250`.
2. Matches products against title, handle, product type, tags, description, and variants.
3. Calls `add_user_to_chat` with this exact body shape:

```json
{
  "chat_id": "$chat_id",
  "user_id": "m.kosnik+wecandoit@text.com",
  "user_type": "agent",
  "visibility": "all",
  "ignore_requester_presence": true
}
```

4. Calls `send_event` with a `rich_message` cards payload.
