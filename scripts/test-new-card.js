const assert = require("assert/strict");

const {
  buildNewCardContent,
  CARD_TEMPLATE_FILE_NAME,
  resolveCursorPlaceholder,
} = require("../out/new-card.js");

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
  "# Template Ignored title\n\nOwner: Jane\n",
  "templates without a title placeholder should append the requested title to line 1"
);

assert.equal(
  buildNewCardContent("Ship it", "# {{TITLE}}\n\nOwner: Jane\n"),
  "# Ship it\n\nOwner: Jane\n",
  "template placeholders should be expanded with the requested title"
);

assert.equal(
  buildNewCardContent("Ship it", "# [bug] {{TITLE}}\n\nOwner: Jane\n"),
  "# [bug] Ship it\n\nOwner: Jane\n",
  "title placeholders should still expand when the title line includes badges"
);

assert.equal(
  buildNewCardContent("Ship it", "# [bug]\n\nOwner: Jane\n"),
  "# [bug] Ship it\n\nOwner: Jane\n",
  "templates without a title placeholder should keep badges and append the title on line 1"
);

assert.equal(
  buildNewCardContent("Ship it", "[bug]\n\nOwner: Jane\n"),
  "# [bug] Ship it\n\nOwner: Jane\n",
  "badge-only first lines should be promoted to a heading so the card title is not the file name"
);

assert.deepEqual(
  resolveCursorPlaceholder("# Ship it\n\nOwner: {{CURSOR}}Jane\n"),
  {
    content: "# Ship it\n\nOwner: Jane\n",
    cursorOffset: "# Ship it\n\nOwner: ".length,
  },
  "cursor placeholders should be removed and reported as an offset"
);

assert.deepEqual(
  resolveCursorPlaceholder("# Ship it\n\nNo cursor here.\n"),
  {
    content: "# Ship it\n\nNo cursor here.\n",
    cursorOffset: null,
  },
  "documents without a cursor placeholder should stay unchanged"
);
