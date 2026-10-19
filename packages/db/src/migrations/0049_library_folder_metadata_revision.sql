-- Folder placement is source metadata. Keep the existing trigger authoritative
-- and include placement without advancing the source content timestamp.
CREATE OR REPLACE FUNCTION sources_metadata_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.metadata_revision := OLD.metadata_revision + CASE WHEN ROW(NEW.title, NEW.author, NEW.description, NEW.tags, NEW.folder_id) IS DISTINCT FROM ROW(OLD.title, OLD.author, OLD.description, OLD.tags, OLD.folder_id) THEN 1 ELSE 0 END;
  RETURN NEW;
END;
$$;
