# Cloudflare R2 gallery media

All gallery thumbnails, covers, backgrounds, social previews, and full-resolution lightbox images load from:

`https://pub-b8191960f89b4ae5905ae36de27a508e.r2.dev`

No R2 credentials are included in the website or repository.

## Prepare the Drive originals

Add the shared **CalBlue Medias** folder as a shortcut in **My Drive**. Wait for Google Drive for Desktop to expose the complete folder under `~/Library/CloudStorage/GoogleDrive-henryoier@gmail.com/My Drive/`.

## Install the media tools

```bash
python3 -m venv .venv-media
.venv-media/bin/pip install --upgrade pip
.venv-media/bin/pip install --index-url https://pypi.org/simple -r scripts/media-requirements.txt
```

## Build each album

The builder numbers images by filename, corrects orientation, creates 1200px thumbnails, and preserves the original pixel dimensions for full-resolution copies.

```bash
.venv-media/bin/python scripts/build_r2_album.py \
  --slug tiger \
  --source "/path/to/CB vs Tiger" \
  --expected 135
```

Repeat with `sfu`, `hehe`, and `nbh`, using expected counts of 24, 66, and 58. The website currently contains the first 28 still photos from the BTG source folder, so build that album with both `--limit 28` and `--expected 28`. Generated files are placed under `.media-build/gallery/<slug>/{thumb,full}/` and excluded from Git.

## Configure R2 credentials locally

Create an R2 API token limited to Object Read & Write access for the media bucket. Copy the provided example and fill it in locally; never commit or share this file:

```bash
cp .env.r2.example .env.r2
chmod 600 .env.r2
```

Set `R2_ACCOUNT_ID`, `R2_BUCKET`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` inside `.env.r2`.

## Upload

```bash
.venv-media/bin/python scripts/upload_r2_media.py --dry-run
.venv-media/bin/python scripts/upload_r2_media.py
```

Objects use stable paths such as:

```text
gallery/tiger/thumb/001.jpg
gallery/tiger/full/001.jpg
gallery/btg/thumb/001.jpg
gallery/btg/full/001.jpg
```

Full-resolution album images load only when a visitor opens the lightbox. The repository does not contain gallery image copies, so verify every uploaded R2 object before deploying website changes.
