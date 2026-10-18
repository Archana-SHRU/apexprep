-- Runs once on first container start (via psql, so meta-commands work and CRLF line
-- endings from a Windows checkout are harmless). Creates <POSTGRES_DB>_test for
-- `npm run test:sql` and the e2e suite, owned by the same role.
SELECT format('CREATE DATABASE %I OWNER %I', current_database() || '_test', current_user)
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() || '_test')
\gexec
