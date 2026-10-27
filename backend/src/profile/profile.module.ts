import {Module} from '@nestjs/common';
import {ProfileStoreService} from './profile-store.service';

@Module({providers: [ProfileStoreService], exports: [ProfileStoreService]})
export class ProfileModule {}
