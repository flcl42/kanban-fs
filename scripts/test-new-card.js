const assert = require("assert/strict");

const { buildNewCardContent, CARD_TEMPLATE_FILE_NAME } = require("../out/new-card.js");

assert.equal(CARD_TEMPLATE_FILE_NAME, "template.md", "card template file name should stay stable");
assert.equal(
  buildNewCardContent("Ship it"),
  "# Ship it\n\n",
  "new cards should default to an H1 heading when no template exists"
);
assert.equal(
  buildNewCardContent("   "),
  "# New ticket\n\n",
  "blank titles should still fall back to the default heading"
);

const templateContent = "# Template\n\nOwner: Jane\n";
assert.equal(
  buildNewCardContent("Ignored title", templateContent),
  templateContent,
  "template content should be used verbatim when template.md exists"
);
