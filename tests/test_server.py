"""Standard-library-only route regression tests. No SearXNG service is needed."""
import importlib.util
import json
import sys
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("browser_llm_test_server", Path(__file__).resolve().parents[1] / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class ServerRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = "http://127.0.0.1:%d" % cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join()

    def request(self, path, body=None, method=None, headers=None):
        req = Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with urlopen(req, timeout=3) as response:
                return response.status, dict(response.headers), response.read()
        except HTTPError as error:
            return error.code, dict(error.headers), error.read()

    def test_new_javascript_route(self):
        status, headers, body = self.request("/models.js?v=models-v1")
        self.assertEqual(status, 200)
        self.assertIn("text/javascript", headers["Content-Type"])
        self.assertIn(b"export const MODELS", body)
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_new_css_route(self):
        self.assertEqual(self.request("/models.css?v=models-v1")[0], 200)

    def test_head_has_no_body(self):
        status, headers, body = self.request("/models.js", method="HEAD")
        self.assertEqual(status, 200)
        self.assertGreater(int(headers["Content-Length"]), 0)
        self.assertEqual(body, b"")

    def test_health_has_new_release_marker(self):
        status, _, body = self.request("/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["version"], "models-v1")
        self.assertEqual(json.loads(body)["inference"], "browser")

    def test_unlisted_files_are_not_exposed(self):
        for path in ["/server.py", "/tests/models.test.mjs", "/package.json", "/../server.py"]:
            self.assertEqual(self.request(path)[0], 404)

    def test_search_cross_origin_still_rejected(self):
        status, _, _ = self.request("/api/search", b'{"q":"test"}',
                                    headers={"Content-Type": "application/json", "Origin": "https://untrusted.invalid"})
        self.assertEqual(status, 403)

    def test_search_input_validation_unchanged(self):
        for body in [b'{"q":""}', b'{"q":12}', b'{"q":"test","time_range":"invalid"}']:
            self.assertEqual(self.request("/api/search", body, headers={"Content-Type": "application/json"})[0], 400)

    def test_search_proxy_still_handles_valid_query(self):
        original = server.search_web
        try:
            server.search_web = lambda query, time_range: {"ok": True, "query": query, "time_range": time_range, "results": []}
            status, _, body = self.request("/api/search", b'{"q":"test","time_range":"day"}', headers={"Content-Type": "application/json"})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["query"], "test")
        finally:
            server.search_web = original

    def test_no_model_inference_post_endpoint_added(self):
        self.assertEqual(self.request("/api/chat", b"{}", headers={"Content-Type": "application/json"})[0], 404)


if __name__ == "__main__":
    unittest.main()
