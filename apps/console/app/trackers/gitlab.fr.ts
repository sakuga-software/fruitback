/** The French of the connector GitLab (FRU-623) (`gitlab.ts`), merged into `messages.fr.ts`. */
export const FRENCH: Readonly<Record<string, string>> = {
  'GitLab address (optional)': 'Adresse de GitLab (facultative)',
  'Leave it empty for gitlab.com. For a self-managed GitLab, its https:// address.':
    'Laissez vide pour gitlab.com. Pour un GitLab auto-hébergé, son adresse https://.',
  'Access token': 'Jeton d’accès',
  'A project access token, with the api scope and the Reporter role. Fruitback keeps it encrypted.':
    'Un jeton d’accès de projet, avec la portée api et le rôle Reporter. Fruitback le garde chiffré.',
  'Fruitback cannot reach this address. Leave it empty for gitlab.com, or give the https:// address of a GitLab that the internet reaches.':
    'Fruitback ne peut pas joindre cette adresse. Laissez vide pour gitlab.com, ou donnez l’adresse https:// d’un GitLab que l’internet atteint.',
  'This is not an access token of GitLab. Copy it again from GitLab, then paste it here.':
    'Ce n’est pas un jeton d’accès de GitLab. Copiez-le de nouveau depuis GitLab, puis collez-le ici.',
  'GitLab refused this token: it is wrong, expired or revoked. Create a new one, then try again.':
    'GitLab a refusé ce jeton : il est faux, expiré ou révoqué. Créez-en un nouveau, puis réessayez.',
  'GitLab refuses the token since {when}: it expired or was revoked, and the notes of its sites do not reach GitLab. Create a new token, disconnect this connector, then connect GitLab again with it.':
    'GitLab refuse le jeton depuis {when} : il a expiré ou a été révoqué, et les notes de ses sites n’arrivent pas dans GitLab. Créez un nouveau jeton, déconnectez ce connecteur, puis connectez GitLab de nouveau avec lui.',
  'Since {when}, GitLab refuses a project that a site sends to, and its notes do not reach GitLab. Give the token the Reporter role on that project again, or choose another project here.':
    'Depuis {when}, GitLab refuse un projet vers lequel un site envoie, et ses notes n’arrivent pas dans GitLab. Rendez au jeton le rôle Reporter sur ce projet, ou choisissez un autre projet ici.',
};
