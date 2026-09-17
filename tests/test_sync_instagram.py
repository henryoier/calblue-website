"""The Instagram importer keeps only what the news feed needs and never touches the network in tests."""

import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("sync_instagram", ROOT / "scripts" / "sync_instagram.py")
IG = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IG)

EMBED = """
<div class="EmbeddedMedia"><img class="EmbeddedMediaImage" src="https://scontent.example/p/photo.jpg?x=1&amp;y=2" alt=""></div>
<div class="Caption"><a class="CaptionUsername" href="/calbluefc/">calbluefc</a> Three points on opening night!<br>What a start. <a href="/explore/tags/GoCalBlue/">#GoCalBlue</a>
<div class="CaptionComments">view all 4 comments</div></div>
<time datetime="2026-09-14T03:12:00.000Z">September 13</time>
"""


class GraphApiTests(unittest.TestCase):
    def test_follows_paging_up_to_the_limit(self):
        pages = {
            "https://graph.instagram.com/me/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=3&access_token=T":
                {"data": [{"id": "1"}, {"id": "2"}], "paging": {"next": "https://next/2"}},
            "https://next/2": {"data": [{"id": "3"}, {"id": "4"}]},
        }
        items = IG.graph_media("T", 3, fetch=lambda url: pages[url])
        self.assertEqual([i["id"] for i in items], ["1", "2", "3"])

    def test_api_error_is_fatal(self):
        with self.assertRaises(SystemExit):
            IG.graph_media("T", 3, fetch=lambda url: {"error": {"message": "Invalid OAuth access token"}})


class EmbedTests(unittest.TestCase):
    def test_shortcode_extraction(self):
        self.assertEqual(IG.shortcode("https://www.instagram.com/p/C_abc-12/?img_index=1"), "C_abc-12")
        self.assertEqual(IG.shortcode("https://www.instagram.com/reel/XYZ/"), "XYZ")
        self.assertIsNone(IG.shortcode("https://www.instagram.com/calbluefc/"))

    def test_embed_page_is_parsed(self):
        post = IG.parse_embed("C_abc", EMBED)
        self.assertEqual(post["media_url"], "https://scontent.example/p/photo.jpg?x=1&y=2")
        self.assertEqual(post["caption"], "Three points on opening night!\nWhat a start. #GoCalBlue")
        self.assertEqual(post["timestamp"], "2026-09-14T03:12:00.000Z")
        self.assertEqual(post["permalink"], "https://www.instagram.com/p/C_abc/")

    def test_url_list_skips_comments_and_non_posts(self):
        fetched = []
        def fetch(url):
            fetched.append(url)
            return EMBED
        items = IG.embed_media(["# season posts", "https://www.instagram.com/calbluefc/", "https://www.instagram.com/p/AAA/ 2026-09-01"], fetch=fetch)
        self.assertEqual(fetched, ["https://www.instagram.com/p/AAA/embed/captioned/"])
        self.assertEqual(items[0]["id"], "AAA")


class NormaliseTests(unittest.TestCase):
    def test_images_are_downloaded_once_and_videos_use_thumbnails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            downloads = []
            def fake_download(url, target):
                downloads.append((url, target.name))
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"jpg")
            media = [
                {"id": "10", "media_type": "IMAGE", "media_url": "https://cdn/a.jpg", "permalink": "https://www.instagram.com/p/a/", "timestamp": "2026-09-14T20:00:00+0000", "caption": " Hello "},
                {"id": "11", "media_type": "VIDEO", "media_url": "https://cdn/v.mp4", "thumbnail_url": "https://cdn/v.jpg", "permalink": "https://www.instagram.com/p/v/", "timestamp": "2026-09-15T20:00:00+0000"},
                {"id": "12", "media_type": "VIDEO", "media_url": "https://cdn/nothumb.mp4", "permalink": "https://www.instagram.com/p/n/", "timestamp": "2026-09-16T20:00:00+0000"},
                {"id": "../13", "media_type": "IMAGE", "media_url": "https://cdn/b.jpg", "permalink": "https://www.instagram.com/p/b/", "timestamp": "bad"},
            ]
            items = IG.normalise(media, root, fetch_image=fake_download)
            self.assertEqual([i["id"] for i in items], ["11", "10", "13"], "newest first, video without thumbnail dropped, id sanitised")
            self.assertEqual(items[0]["image"], "assets/news/instagram/11.jpg")
            self.assertEqual(items[1]["caption"], "Hello")
            self.assertEqual(items[1]["timestamp"], "2026-09-14T20:00:00+00:00")
            self.assertEqual(sorted(name for _, name in downloads), ["10.jpg", "11.jpg", "13.jpg"])
            IG.normalise(media, root, fetch_image=fake_download)
            self.assertEqual(len(downloads), 3, "existing images are not downloaded again")

    def test_written_file_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "instagram.json"
            IG.write([{"id": "1"}], target)
            payload = target.read_text(encoding="utf-8")
            self.assertIn('"schemaVersion": 1', payload)
            self.assertIn('"account": "calbluefc"', payload)


if __name__ == "__main__":
    unittest.main()
