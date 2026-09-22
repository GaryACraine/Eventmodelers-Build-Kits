#!/usr/bin/env bash
# Increment t3: students can unsubscribe; CourseDetails copy 3 (staged as draft).
# Run from your project root on branch increment/t3:  bash ~/Projects/Eventmodelers-Build-Kits/docs/examples/t3.sh
set -euo pipefail
source em-helpers.sh

REG_EVT=$(el_id 'register course' event courseWasRegistered)
CAP_EVT=$(el_id 'change course capacity' event courseCapacityWasChanged)
RS_EVT=$(el_id 'register student' event studentWasRegistered)
SUB_EVT=$(el_id 'subscribe student' event studentWasSubscribed)

emcli slice add "$(chapter_id)" "unsubscribe student" >/dev/null
emcli element add "$(chapter_id)" "$(slice_id 'unsubscribe student')" "$(lane_id Enrollment)" command unsubscribeStudent >/dev/null
emcli element add "$(chapter_id)" "$(slice_id 'unsubscribe student')" "$(lane_id 'Enrollment Events')" event studentWasUnsubscribed >/dev/null
UNSUB_CMD=$(el_id 'unsubscribe student' command unsubscribeStudent); UNSUB_EVT=$(el_id 'unsubscribe student' event studentWasUnsubscribed)
for el in "$UNSUB_CMD" "$UNSUB_EVT"; do
  emcli element field add "$(chapter_id)" "$el" courseId String --id --example c1 >/dev/null
  emcli element field add "$(chapter_id)" "$el" studentId String --id --example s1 >/dev/null
done
emcli dependency add "$UNSUB_CMD" "$UNSUB_EVT" produces >/dev/null
emcli element update "$(chapter_id)" "$UNSUB_CMD" --api-endpoint "/courses/{courseId}/students/{studentId}" >/dev/null

sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'unsubscribe student')" "unsubscribes a subscribed student" --json | jq -r .id)
step "unsubscribe student" "$sp" given event "$SUB_EVT"; step "unsubscribe student" "$sp" when command "$UNSUB_CMD"
step "unsubscribe student" "$sp" then event "$UNSUB_EVT"
for ph in given when then; do ex "unsubscribe student" "$sp" $ph 0 courseId c1; ex "unsubscribe student" "$sp" $ph 0 studentId s1; done
sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'unsubscribe student')" "rejects unsubscribing a student who is not subscribed" --json | jq -r .id)
step "unsubscribe student" "$sp" when command "$UNSUB_CMD"
error_step "unsubscribe student" "$sp" "Student is not subscribed"
ex "unsubscribe student" "$sp" when 0 courseId c1; ex "unsubscribe student" "$sp" when 0 studentId s1

emcli slice add "$(chapter_id)" "course details unsubscriptions" >/dev/null
emcli element copy "$(chapter_id)" "$(el_id 'course details' information CourseDetails)" \
  --slice "$(slice_id 'course details unsubscriptions')" --lane "$(lane_id Enrollment)" >/dev/null
DETAILS_3=$(el_id 'course details unsubscriptions' information CourseDetails)
emcli element field add "$(chapter_id)" "$DETAILS_3" subscribedStudents Custom --cardinality List --subfields "studentId:String,name:String" >/dev/null
for e in "$REG_EVT" "$CAP_EVT" "$RS_EVT" "$SUB_EVT" "$UNSUB_EVT"; do emcli dependency add "$e" "$DETAILS_3" hydrates >/dev/null; done

sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'course details unsubscriptions')" "an unsubscribed student is no longer listed" --json | jq -r .id)
step "course details unsubscriptions" "$sp" given event "$REG_EVT"
step "course details unsubscriptions" "$sp" given event "$RS_EVT"
step "course details unsubscriptions" "$sp" given event "$SUB_EVT"
step "course details unsubscriptions" "$sp" given event "$UNSUB_EVT"
step "course details unsubscriptions" "$sp" then readmodel "$DETAILS_3"
ex "course details unsubscriptions" "$sp" given 0 courseId c1; ex "course details unsubscriptions" "$sp" given 0 title Math; ex "course details unsubscriptions" "$sp" given 0 capacity 30
ex "course details unsubscriptions" "$sp" given 1 studentId s1; ex "course details unsubscriptions" "$sp" given 1 name Ada
for i in 2 3; do ex "course details unsubscriptions" "$sp" given $i courseId c1; ex "course details unsubscriptions" "$sp" given $i studentId s1; done
ex "course details unsubscriptions" "$sp" then 0 courseId c1; ex "course details unsubscriptions" "$sp" then 0 subscribedStudents '[]'

emcli slice status "$(chapter_id)" "$(slice_id 'unsubscribe student')" planned >/dev/null
emcli slice status "$(chapter_id)" "$(slice_id 'course details unsubscriptions')" draft >/dev/null
echo "t3 modeled: 'unsubscribe student' planned, 'course details unsubscriptions' draft"
