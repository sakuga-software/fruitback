---
'@fruitback/widget': patch
---

A capture that the browser refused for want of a gesture on the extension now says « Click the Fruitback icon in the toolbar, then try again. » instead of « The capture was not taken ». A host signals this refusal by rejecting `captureVisible` with an error named `NotAllowedError`. Any other failure keeps the message of before.
