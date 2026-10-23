# What the team sees

Where the notes go is the site's choice in the console. **In the database**, the default, the
« Notes » screen of the console lists them, and the pins on the page are the thread. **In a tracker**,
a note becomes an issue titled with the reporter's own words, carrying the CSS selector, the React
component and the source file, and replying in the issue puts the reply back inside the pin on the
page — that is the loop closing, and it needs nothing configured.

If your team treats issue comments as internal, turn that off: the switch « Show Linear comments as
replies » of the connector, or `FRUITBACK_HIDE_COMMENTS=1` for the whole instance. On a site that
everyone reads, the read path needs no authentication, so anything it returns is readable by anyone
who can load the page.
