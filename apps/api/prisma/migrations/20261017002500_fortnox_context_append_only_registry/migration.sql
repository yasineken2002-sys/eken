-- Behåll den redan införda radspärren för INSERT/UPDATE/DELETE och dess
-- förseglings-/kaskadregler. Satsnivåspärren följer det gemensamma append-only-
-- kontraktet och stoppar även UPDATE som matchar noll rader. Ingen tidigare
-- migration eller lagrad snapshot ändras.
CREATE FUNCTION fortnox_context_page_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FortnoxReadContextPage is append-only: frozen pages are immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER append_only_fortnox_read_context_page
  BEFORE UPDATE ON "FortnoxReadContextPage"
  FOR EACH STATEMENT EXECUTE FUNCTION fortnox_context_page_append_only();
