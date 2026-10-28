-- Seats in a block can be numbered from the right-hand end (S1 on the right).
ALTER TABLE "room_blocks" ADD COLUMN "seats_from_right" BOOLEAN NOT NULL DEFAULT false;
