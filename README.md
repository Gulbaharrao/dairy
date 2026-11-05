# Gulbahar Dairy Website

- `index.html` — public website (Rozana Khata Book, order, FAQ, contact)
- `_headers` (Netlify/Cloudflare Pages) ya `.htaccess` (Apache) — security headers, hosting par upload zaroor karein
- Koi external CDN/library nahi — poori site self-contained hai.

Khata ka data browser mein rehta hai: regular "Backup Download" lein.

## Theme aur icons
- Dark/Light toggle header mein hai; choice browser mein yaad rehti hai, pehli baar device ki setting follow hoti hai (`js/theme.js`).
- Icons: Material Design Icons (Apache 2.0) aur WhatsApp ka official logo (Simple Icons, CC0), inline sprite ke roop mein.
- Fonts: Inter (body) aur Crimson Pro (headings), dono SIL Open Font License; `fonts/` mein self-hosted, license files saath hain.
