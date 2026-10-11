import Foundation
import Testing
@testable import KitHTML

private let page = """
<html><head><title> Uploads - Site </title></head><body>
<div class="pagination"><a href="/account/uploads/1">1</a><a href="/account/uploads/2" class="next">2</a><a href="https://ads.test/x">ad</a></div>
<div id="listing-video-11" class="thumb-block"><p class="title"><a href="/video.abc/first_[2026-01-20 140639 alice]" title="t">First</a></p><p>Duration: 61 min</p></div>
<div id="listing-video-12" class="thumb-block frame"><p class="title"><a href="/video.def/second">Second</a></p>
<p class=inf><a href='/video/77/x/'>Seventy seven</a><span class="durations">4:42</span></div>
<ul id="chapterlist"><li><a href="/c-3/">3</a></li><li><a href="/c-2/">2</a></li><li><a>none</a></li></ul>
<img data-src="https://media.test/1.webp"><section><p>tag soup <b>bold</div>
</body></html>
"""

@Test func selectorsFindElements() throws {
    let document = try HTMLDocument(page)
    #expect(document.title == "Uploads - Site")
    #expect(try document.select("[id^=\"listing-video-\"]").map { $0["id"] } == ["listing-video-11", "listing-video-12"])
    #expect(try document.select(".pagination a[href^='/account/uploads']").count == 2)
    #expect(try document.select("div.thumb-block.frame").count == 1)
    #expect(try document.select("#chapterlist a[href]").compactMap { $0["href"] } == ["/c-3/", "/c-2/"])
    #expect(try document.select("ul > li:first-child > a").first?.text == "3")
    #expect(try document.select("li:nth-child(2) a").first?["href"] == "/c-2/")
    #expect(try document.select("p.inf a[href*='/video/77/']").first?.normalizedText == "Seventy seven")
    #expect(try document.select("p.title + p").first?.text == "Duration: 61 min")
    #expect(try document.select("a:not(.next)").count == 8)
    #expect(try document.select("img[data-src$='.webp'], b").count == 2)
    #expect(try document.first("section b")?.normalizedText == "bold")
}

@Test func relativeSelection() throws {
    let document = try HTMLDocument(page)
    let rows = try document.select("[id^='listing-video-']")
    #expect(try rows[0].first(".title a")?["href"] == "/video.abc/first_[2026-01-20 140639 alice]")
    #expect(try rows[1].select("> p").count == 2)
    #expect(try rows[1].first(".durations")?.text == "4:42")
    #expect(rows[1].attributes["class"] == "thumb-block frame")
    #expect(rows[0].parent?.name == "body")
}

@Test func badSelectorsThrow() throws {
    let document = try HTMLDocument(page)
    #expect(throws: HTMLError.self) { try document.select("a[") }
    #expect(throws: HTMLError.self) { try document.select(":hover") }
    #expect(CSSSelector.literal("it's") == "\"it's\"")
    #expect(CSSSelector.literal("a'b\"c") == "concat('a', \"'\", 'b\"c')")
}
