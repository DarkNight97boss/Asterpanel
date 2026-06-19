-- Git push-to-deploy: a bare repo per site whose post-receive hook checks the
-- pushed branch out into the site's working tree. Provisioned on the node by the
-- signed git.repo.ensure job; the clone URL is shown to the user for `git remote`.
CREATE TABLE git_repos (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    website_id      uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
    branch          text NOT NULL DEFAULT 'main',
    clone_url       text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (website_id)
);

CREATE INDEX idx_git_repos_org ON git_repos (organization_id);
