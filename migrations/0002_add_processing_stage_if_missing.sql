-- Add processing_stage column if it doesn't exist (for databases created before it was in schema)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'video_projects' AND column_name = 'processing_stage'
    ) THEN
        ALTER TABLE video_projects ADD COLUMN processing_stage TEXT;
    END IF;
END $$;
