# Several sites, one instance

Add each site in the console: one address, one id, one visibility. A site is the client of one
workspace, so a session of another workspace reads and writes nothing there. A workspace per client
keeps their notes and their members apart; a guest of one site reads that site and no other of the
workspace (FRU-250).

Each site is bound to its address. The worker refuses a note or a read that names a site from the page
of another origin (`403 origin-not-allowed-for-client`), and a page that is on no site
(`403 origin-not-allowed`). It is not authentication: the id of a site is asserted by the browser, and
`Origin` is what the browser says about the page. It is the same trust level CORS gives, and strictly
more than nothing. [SECURITY.md](https://github.com/sakuga-software/fruitback/blob/main/SECURITY.md) says what it stops.
