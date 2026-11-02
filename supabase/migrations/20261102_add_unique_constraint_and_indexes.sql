-- Add unique constraint on (title, release_year, media_type)
-- to prevent duplicate entries across media types
ALTER TABLE movies
ADD CONSTRAINT movies_title_year_media_type_unique
UNIQUE (title, release_year, media_type);

-- Add indexes for faster filtering and dedup checks
CREATE INDEX IF NOT EXISTS movies_media_type_idx ON movies(media_type);
CREATE INDEX IF NOT EXISTS movies_release_year_idx ON movies(release_year);
CREATE INDEX IF NOT EXISTS movies_title_media_type_idx ON movies(title, media_type);

-- Add index for common search patterns (title + year)
CREATE INDEX IF NOT EXISTS movies_title_year_idx ON movies(title, release_year);
