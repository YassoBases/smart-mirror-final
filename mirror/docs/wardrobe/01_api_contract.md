# Wardrobe API contract (single source of truth)

Both clients depend on this. The **Flutter app** is the canonical consumer and
uses the JWT routes below. The **mirror widget** has no JWT, so it uses a thin
parallel public route set (see "Mirror routes") that resolves `mid → active
profile` and otherwise returns identical bodies.

- Base path: everything is mounted under the existing API base **`/api`**
  (the Flutter app's `baseUrl` already ends in `/api`).
- Auth (Flutter routes): `Authorization: Bearer <jwt>`, the same
  `authenticate` middleware every existing route uses. The decoded
  `req.account.householdId` scopes access.
- **Household scoping is enforced on every route**: the `:profileId` must belong
  to the caller's household, else **403**. (Mirror routes resolve the profile
  from `mid` via the active-user mechanism, which is implicitly mirror-scoped.)
- Validation: request bodies are validated with **zod**; invalid → **400** with
  `{ error }`.
- Image URLs are derived from the runtime server root (request host) +
  static path, exactly like `faceUrl`. Files are stored on disk; only filenames
  live in the DB.

---

## JWT routes (Flutter)

### Wardrobe items

```
POST   /profiles/:profileId/wardrobe/items
        multipart: field "image" (raw garment photo)
        -> bg removal -> BLIP-2 caption -> stores image+thumb -> inserts row
        -> 201 { item, aiAttributesAvailable: boolean }

GET    /profiles/:profileId/wardrobe/items?category=top&season=winter
        (filters optional: category, season)
        -> 200 { items: [ <item>, ... ] }

PATCH  /profiles/:profileId/wardrobe/items/:id
        body: editable attrs (see "Editable attributes")
        -> 200 { item }

DELETE /profiles/:profileId/wardrobe/items/:id
        -> 204 (soft delete: sets deleted = 1)
```

### Base body photo (one per profile, reused for every VTON render)

```
POST   /profiles/:profileId/body-photo
        multipart: field "photo"
        -> 200 { bodyPhotoUrl }

GET    /profiles/:profileId/body-photo
        -> 200 { bodyPhotoUrl | null }
```

### Outfit suggestion + render

```
POST   /profiles/:profileId/outfit/suggest
        body: { count?, occasion? }   (default count 3; occasion e.g.
               "casual"|"smart casual"|"business"|"formal"|"sport"|"party",
               "any"/omitted = no preference)
        -> 200 { candidates: [{ itemIds:[int], reasoning, confidence }], context }
           (context now also carries `occasion` when one was given)

POST   /profiles/:profileId/outfit/generate
        body: { count?, occasion? }   (invent NEW ideas, not from the closet)
        -> 200 { candidates: [{ items:[{ category, subcategory, primaryColor,
                 pattern, formality, warmth, seasons, description, imageUrl,
                 searchUrl }], reasoning, confidence }], context }
           imageUrl is null when image generation is unconfigured (concept-only);
           searchUrl is a Google Shopping search link built from `description`.
        -> 503 when the stylist (ANTHROPIC_API_KEY) is not configured.

POST   /profiles/:profileId/outfit/render
        body: { itemIds:[int] }
        -> 200 { renderUrl, fromCache }
```

### Feedback

```
POST   /profiles/:profileId/outfit/feedback
        body: { itemIds:[int], rating:"up"|"down", reasoningShown, context }
              OR (for generated outfits, no closet ids):
              { items:[{ category, subcategory, primaryColor, pattern,
                 formality, warmth, seasons }], rating, reasoningShown, context }
        -> 200 { ok: true }
        Either itemIds or items is required. Both kinds train the same
        per-profile preference model (generated items via items_snapshot).

GET    /profiles/:profileId/outfit/feedback?limit=&offset=
        -> 200 { feedback: [ <feedbackRow incl. itemsSnapshot>, ... ] }
```

### Context (weather/time/season)

```
GET    /profiles/:profileId/context
        -> 200 { temperature, weather, timeOfDay, season }
```

### Demo metrics

```
GET    /profiles/:profileId/metrics/acceptance
        -> 200 { buckets: [{ weekStart, total, accepted, rate }], modelTrainedAt }
```

---

## Mirror routes (widget — no JWT, mirror-id keyed)

Same handlers, but the profile is resolved from the active-user mechanism
(`mid` = the mirror's UUID) instead of `:profileId` + JWT. Bodies are identical.

```
POST   /mirrors/wardrobe/items?mid=<mirrorId>          (same as POST items)
GET    /mirrors/wardrobe/items?mid=<mirrorId>&category=&season=
PATCH  /mirrors/wardrobe/items/:id?mid=<mirrorId>
DELETE /mirrors/wardrobe/items/:id?mid=<mirrorId>
POST   /mirrors/wardrobe/body-photo?mid=<mirrorId>
GET    /mirrors/wardrobe/body-photo?mid=<mirrorId>
POST   /mirrors/wardrobe/outfit/suggest?mid=<mirrorId>
POST   /mirrors/wardrobe/outfit/generate?mid=<mirrorId>
POST   /mirrors/wardrobe/outfit/render?mid=<mirrorId>
POST   /mirrors/wardrobe/outfit/feedback?mid=<mirrorId>
GET    /mirrors/wardrobe/outfit/feedback?mid=<mirrorId>&limit=&offset=
GET    /mirrors/wardrobe/context?mid=<mirrorId>
GET    /mirrors/wardrobe/metrics/acceptance?mid=<mirrorId>
```

If `mid` has no active profile → `404 { error: "No active profile on this mirror" }`.

---

## Item attribute shape (JSON returned and accepted)

```json
{
  "id": 123,
  "profileId": 4,
  "imageUrl": "<server>/wardrobe/4/123/nobg.png",
  "thumbnailUrl": "<server>/wardrobe/4/123/thumb.jpg",
  "category": "top",
  "subcategory": "henley",
  "primaryColor": "#7A8B9D",
  "secondaryColors": ["#FFFFFF"],
  "pattern": "solid",
  "fabricGuess": "cotton jersey",
  "formality": 2,
  "warmth": 2,
  "seasons": ["spring", "autumn"],
  "tags": ["casual", "long-sleeve"],
  "lastWornAt": null,
  "createdAt": "..."
}
```

- `category` ∈ `top | bottom | outerwear | footwear | accessory`
- `pattern` ∈ `solid | stripe | plaid | print | other`
- `formality`, `warmth` ∈ integers `1..5`
- `secondaryColors`, `seasons`, `tags` are arrays (stored as JSON TEXT in SQLite)
- `imageUrl`/`thumbnailUrl` are built from the request host at response time.

### Editable attributes (PATCH body, all optional)

`category, subcategory, primaryColor, secondaryColors, pattern, fabricGuess,
formality, warmth, seasons, tags, lastWornAt`. Server ignores any other key.
`imageUrl/thumbnailUrl/id/profileId/createdAt` are read-only.

### POST items extra field

`aiAttributesAvailable: boolean` — `false` when the BLIP-2 endpoint is unset and
the server returned stub defaults, so the client should prompt the user to fill
attributes in.

## Context shape

```json
{ "temperature": 18.4, "weather": "Clouds", "timeOfDay": "evening", "season": "spring" }
```

`timeOfDay` ∈ `morning | afternoon | evening | night`.
`season` ∈ `winter | spring | summer | autumn`.
