# Warp shortcuts and compact facts

The eligible focused row advertises **Ctrl+D delete**, matching the actual
binding. Principal, current, unregistered and offer rows retain their deletion
guards; changing the legend grants no deletion authority.

While search is active, Delete clears the whole query and Backspace removes one
character. Outside search, Delete does nothing. The association picker uses the
same search rule. The clear hint appears only in the active-search footer; every
footer stays on one row.

Compact previews show `created —` / `modified —` when an age is unavailable.
Detailed reasons remain in row data, not on screen. Readable timestamps still
show their real age; no date is fabricated.

Tests: `node --test tools/warp-selector-view.test.js tools/warp-create-picker.test.js`.
Creation geometry is documented separately in [warp-create-feedback.md](warp-create-feedback.md).
