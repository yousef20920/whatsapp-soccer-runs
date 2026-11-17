-- Short-lived copy of Active Mississauga's openings, so /available answers fast and
-- the City's site is only asked once every 15 minutes at most.
CREATE TABLE IF NOT EXISTS facility_availability (
    resource_id INT PRIMARY KEY,
    fetched_at TIMESTAMP WITH TIME ZONE NOT NULL,
    days JSONB NOT NULL -- { "2026-11-22": [{"start": 1170, "end": 1440}], ... } minutes after midnight
);

ALTER TABLE facility_availability ENABLE ROW LEVEL SECURITY;
