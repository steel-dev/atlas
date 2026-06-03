import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./html-extract.js";

const BASE = "https://example.com/docs/page";

function md(html: string): string {
  return htmlToMarkdown(html, BASE).markdown;
}

describe("htmlToMarkdown", () => {
  it("emits nested block text exactly once", () => {
    const markdown = md(`<html><body><main>
      <ul><li><p>Revenue was $4.2M in 2024.</p></li><li>Simple item</li></ul>
      <blockquote><p>Quoted insight.</p></blockquote>
    </main></body></html>`);
    expect(markdown.match(/Revenue was \$4\.2M in 2024\./g)).toHaveLength(1);
    expect(markdown.match(/Quoted insight\./g)).toHaveLength(1);
    expect(markdown).toContain("- Revenue was $4.2M in 2024.");
    expect(markdown).toContain("- Simple item");
    expect(markdown).toContain("> Quoted insight.");
  });

  it("renders tables as markdown tables preserving row association", () => {
    const markdown = md(`<html><body><table>
      <caption>Annual revenue</caption>
      <thead><tr><th>Year</th><th>Revenue</th></tr></thead>
      <tbody>
        <tr><td>2024</td><td>$4.2M</td></tr>
        <tr><td>2025</td><td>$7.1M</td></tr>
      </tbody>
    </table></body></html>`);
    expect(markdown).toContain("Annual revenue");
    expect(markdown).toContain("| Year | Revenue |");
    expect(markdown).toContain("| --- | --- |");
    expect(markdown).toContain("| 2024 | $4.2M |");
    expect(markdown).toContain("| 2025 | $7.1M |");
  });

  it("pads ragged table rows and escapes pipes in cells", () => {
    const markdown = md(`<html><body><table>
      <tr><th>Name</th><th>Spec</th></tr>
      <tr><td>Widget</td><td>4|6 mm</td></tr>
      <tr><td>Orphan</td></tr>
    </table></body></html>`);
    expect(markdown).toContain("| Widget | 4\\|6 mm |");
    expect(markdown).toContain("| Orphan |  |");
  });

  it("preserves pre blocks as code fences with language", () => {
    const markdown = md(`<html><body>
      <pre><code class="language-bash">npm install atlas
npm run build</code></pre>
    </body></html>`);
    expect(markdown).toContain("```bash\nnpm install atlas\nnpm run build\n```");
  });

  it("wraps inline code in backticks", () => {
    const markdown = md(
      "<html><body><p>Call <code>fetch()</code> once.</p></body></html>",
    );
    expect(markdown).toContain("Call `fetch()` once.");
  });

  it("renders inline links with absolute targets", () => {
    const markdown = md(
      '<html><body><p>See <a href="/report">the full report</a> today.</p></body></html>',
    );
    expect(markdown).toContain(
      "See [the full report](https://example.com/report) today.",
    );
  });

  it("keeps anchor text but drops fragment and javascript targets", () => {
    const markdown = md(`<html><body><p>
      <a href="#section">Jump</a> and <a href="javascript:void(0)">Click</a>
    </p></body></html>`);
    expect(markdown).toContain("Jump and Click");
    expect(markdown).not.toContain("](");
  });

  it("renders nested and ordered lists with indentation", () => {
    const markdown = md(`<html><body>
      <ol>
        <li>First</li>
        <li>Second
          <ul><li>Nested A</li><li>Nested B</li></ul>
        </li>
      </ol>
    </body></html>`);
    expect(markdown).toContain("1. First");
    expect(markdown).toContain("2. Second");
    expect(markdown).toContain("   - Nested A");
    expect(markdown).toContain("   - Nested B");
  });

  it("captures bare text inside divs", () => {
    const markdown = md(`<html><body>
      <p>Intro paragraph.</p>
      <div>Price: <span>$19.99</span></div>
    </body></html>`);
    expect(markdown).toContain("Intro paragraph.");
    expect(markdown).toContain("Price: $19.99");
  });

  it("renders definition lists as associated pairs", () => {
    const markdown = md(`<html><body><dl>
      <dt>Latency</dt><dd>12ms</dd>
      <dt>Throughput</dt><dd>4k rps</dd>
    </dl></body></html>`);
    expect(markdown).toContain("- Latency: 12ms");
    expect(markdown).toContain("- Throughput: 4k rps");
  });

  it("separates flattened block children inside table cells", () => {
    const markdown = md(`<html><body><table>
      <tr><th>Notes</th></tr>
      <tr><td><p>Alpha</p><p>Beta</p></td></tr>
    </table></body></html>`);
    expect(markdown).toContain("| Alpha Beta |");
  });

  it("prefers main content as the extraction root", () => {
    const extraction = htmlToMarkdown(
      `<html><head><title>Doc Title</title></head><body>
        <nav><a href="/home">Home</a></nav>
        <main><h2>Section</h2><p>Body text.</p></main>
      </body></html>`,
      BASE,
    );
    expect(extraction.title).toBe("Doc Title");
    expect(extraction.markdown).toContain("## Section");
    expect(extraction.markdown).toContain("Body text.");
    expect(extraction.markdown).not.toContain("Home");
    expect(extraction.links.map((link) => link.url)).toContain(
      "https://example.com/home",
    );
  });
});
