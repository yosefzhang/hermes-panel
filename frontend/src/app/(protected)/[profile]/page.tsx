import { redirect } from 'next/navigation';

export default function ProfileIndex({ params }: { params: { profile: string } }) {
  redirect(`/${params.profile}/models`);
}