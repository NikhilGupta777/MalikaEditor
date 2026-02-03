-- Add transcript_enhanced column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'video_projects' AND column_name = 'transcript_enhanced'
    ) THEN
        ALTER TABLE video_projects ADD COLUMN transcript_enhanced JSONB;
    END IF;
END $$;
