-- Wikipedia Through Time: one database, two datasets.
--   S (now):     current_article, article_vector, category_link, article_category
--   M (history): article (system-versioned, real Wikipedia edit times), revision (metadata of every version)

-- ---------------------------------------------------------------------------------------------
-- M: every version of an article, kept by MariaDB itself. One row per article = what Wikipedia
-- shows today; earlier versions are history rows written with their real edit times via
-- system_versioning_insert_history. FOR SYSTEM_TIME AS OF '2015-06-01' = what Wikipedia showed then.
CREATE TABLE IF NOT EXISTS article (
  page_id     INT UNSIGNED NOT NULL,
  title       VARCHAR(255) NOT NULL,          -- as it was then: pages get renamed
  rev_id      INT UNSIGNED NOT NULL,
  user        VARCHAR(255),
  anonymous   BOOL NOT NULL DEFAULT 0,
  comment     TEXT,
  minor       BOOL NOT NULL DEFAULT 0,
  sha1        CHAR(31),
  len         INT UNSIGNED,
  text        MEDIUMTEXT COMPRESSED NOT NULL,
  row_start   TIMESTAMP(6) GENERATED ALWAYS AS ROW START INVISIBLE,
  row_end     TIMESTAMP(6) GENERATED ALWAYS AS ROW END INVISIBLE,
  PERIOD FOR SYSTEM_TIME (row_start, row_end),
  PRIMARY KEY (page_id),
  KEY (sha1),
  KEY start_key (page_id, row_start)          -- the history index is ordered by row_end; AS OF old dates needs this
) WITH SYSTEM VERSIONING;

-- Metadata of all 862,076 versions of all 19,742 articles (no text): for the big-picture views
-- even where article holds no text. Derived columns are filled by scripts/derive.py.
CREATE TABLE IF NOT EXISTS revision (
  rev_id      INT UNSIGNED NOT NULL PRIMARY KEY,
  parent_id   INT UNSIGNED,
  page_id     INT UNSIGNED NOT NULL,
  title       VARCHAR(255) NOT NULL,
  ts          DATETIME(6) NOT NULL,           -- UTC
  user        VARCHAR(255),
  anonymous   BOOL NOT NULL,
  minor       BOOL NOT NULL,
  sha1        CHAR(31),
  bytes       INT UNSIGNED NOT NULL,
  delta       INT,                            -- bytes minus the previous version's
  is_revert   BOOL,                           -- text equals an earlier version, not the one just before
  comment     TEXT,
  has_text    BOOL NOT NULL DEFAULT 0,        -- this article's text is in `article`
  KEY page_ts (page_id, ts),
  KEY (ts),
  KEY (user)
);

-- ---------------------------------------------------------------------------------------------
-- S: the current text of the History of Finland articles in fi/sv/en, clean Markdown (FineWiki).
CREATE TABLE IF NOT EXISTS current_article (
  lang          CHAR(2)      NOT NULL,
  page_id       INT UNSIGNED NOT NULL,
  rev_id        INT UNSIGNED NOT NULL,
  wikidata_id   VARCHAR(20),
  title         VARCHAR(255) NOT NULL,
  url           VARCHAR(500) NOT NULL,
  date_modified DATETIME,
  text          MEDIUMTEXT   NOT NULL,
  PRIMARY KEY (lang, page_id),
  KEY (wikidata_id),
  FULLTEXT (title, text)
);

-- One bge-m3 vector per article (1024 dims). A VECTOR INDEX column must be NOT NULL.
CREATE TABLE IF NOT EXISTS article_vector (
  lang       CHAR(2)      NOT NULL,
  page_id    INT UNSIGNED NOT NULL,
  model      VARCHAR(50)  NOT NULL,
  truncated  BOOL         NOT NULL,
  embedding  VECTOR(1024) NOT NULL,
  PRIMARY KEY (lang, page_id),
  VECTOR INDEX (embedding) M=16 DISTANCE=cosine   -- M=6 default gave 79% recall@10 in the reference demo
);

CREATE TABLE IF NOT EXISTS category_link (
  parent  VARCHAR(255) NOT NULL,
  child   VARCHAR(255) NOT NULL,
  PRIMARY KEY (parent, child),
  KEY (child)
);

CREATE TABLE IF NOT EXISTS article_category (
  lang      CHAR(2)      NOT NULL,
  page_id   INT UNSIGNED NOT NULL,
  category  VARCHAR(255) NOT NULL,
  PRIMARY KEY (lang, page_id, category),
  KEY (category)
);
