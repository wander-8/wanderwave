-- Allow anonymous user posting with guest_id
ALTER TABLE movie_reviews
ADD COLUMN guest_id VARCHAR(20) DEFAULT NULL,
ALTER COLUMN user_id DROP NOT NULL;

-- Anonymous users identified by guest_id, registered by user_id
CREATE INDEX IF NOT EXISTS movie_reviews_guest_id_idx ON movie_reviews(guest_id);

-- Constraint: each movie can have 1 review per user, or multiple guest reviews
-- (guest reviews are differentiated by guest_id, not by user_id)
ALTER TABLE movie_reviews
DROP CONSTRAINT movie_reviews_movie_id_user_id_key;

-- New constraint: (movie_id, user_id) unique for registered users, allowing nulls
CREATE UNIQUE INDEX movie_reviews_movie_user_unique
ON movie_reviews(movie_id, user_id)
WHERE user_id IS NOT NULL;
